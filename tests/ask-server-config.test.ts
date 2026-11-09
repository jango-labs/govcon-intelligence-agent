import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmp, profile } from './helpers.ts';
import { Db } from '../src/db.ts';
import { runPipeline } from '../src/pipeline/run.ts';
import { ask, parseQuestion, sanitizeFilter } from '../src/ask/ask.ts';
import { introducesNewFacts } from '../src/ask/llm.ts';
import { parseEnv, deepMerge, validateProfile, DEFAULT_PROFILE, loadExampleProfile } from '../src/config.ts';
import { setEnvValue } from '../src/envfile.ts';
import { isDueTz, nextRuns } from '../src/cron.ts';
import { simpleDaily, plist, systemdUnits } from '../src/schedule.ts';

let dir: string; let db: Db;
beforeAll(async () => { dir = tmp(); db = new Db(join(dir, 'a.sqlite')); await runPipeline({ demo: true, db, profile: profile(), reportDir: join(dir, 'r'), now: new Date('2026-11-09T12:00:00Z'), sampleAnchor: '2026-11-09' }); });

describe('natural-language questions (no AI)', () => {
  it('parses departments, windows, values, priorities and intents', () => {
    expect(parseQuestion('Which DHS opportunities release in the next 6 months?')).toMatchObject({ departments: ['DHS'], monthsFrom: 0, monthsTo: 6 });
    expect(parseQuestion('high priority recompetes at the Army')).toMatchObject({ priorities: ['High'], agencies: ['Army'] });
    expect(parseQuestion('how many opportunities over $10 million')).toMatchObject({ intent: 'count', minValue: 1e7 });
    expect(parseQuestion('what changed since yesterday?').intent).toBe('changes');
    expect(parseQuestion('opportunities in months 12-24')).toMatchObject({ monthsFrom: 12, monthsTo: 24 });
  });
  it('answers from stored data with caveats and links', async () => {
    const a = await ask(db, 'Show high and medium priority recompetes for DHS', profile(), { today: '2026-11-09' });
    expect(a.rows.length).toBeGreaterThan(0); expect(a.rows.every((r) => r.department === 'DHS' && ['High', 'Medium'].includes(r.priority))).toBe(true);
    expect(a.text).toContain('SYNTHETIC demo data'); expect(a.usedModel).toBe(false);
    expect((await ask(db, 'how many cloud migration opportunities', profile())).text).toMatch(/\d+ active opportunit/);
    expect((await ask(db, 'did all sources run ok?', profile())).text).toContain('Synthetic demo data');
    expect((await ask(db, 'help', profile())).text).toContain('Examples');
  });
  it('honestly says when nothing matches and when no run exists', async () => {
    expect((await ask(db, 'opportunities for NASA over $900 million', profile())).text).toMatch(/No active opportunities match/);
    expect((await ask(new Db(':memory:'), 'anything', profile())).text).toContain('No run has completed');
  });
  it('model output filters are whitelisted and rephrasing cannot add facts', () => {
    const f = sanitizeFilter({ departments: ['DHS'], classifications: ['evil', 'likely_recompete'], limit: 9999, sql: 'drop table opp', minValue: 'abc', sort: 'DROP' });
    expect(f.classifications).toEqual(['likely_recompete']); expect(f.limit).toBe(200); expect((f as any).sql).toBeUndefined(); expect(f.minValue).toBeUndefined(); expect(f.sort).toBeUndefined();
    expect(introducesNewFacts('Three DHS awards total $5M.', 'Three DHS awards total $50M.')).toBe(true);
    expect(introducesNewFacts('Three DHS awards total $5M.', 'DHS has three awards totalling $5M.')).toBe(false);
    expect(introducesNewFacts('Three DHS awards.', 'Lockheed won three DHS awards.')).toBe(true);
  });
});
describe('configuration, secrets file, scheduling', () => {
  it('validates profiles and merges defaults', () => {
    expect(validateProfile(loadExampleProfile())).toEqual([]);
    const bad = deepMerge(DEFAULT_PROFILE, { windowMonths: 0, schedule: 'nope', timezone: 'Mars/Base', keywords: [] }); expect(validateProfile(bad).length).toBeGreaterThanOrEqual(4);
  });
  it('parses .env and writes secrets with owner-only permissions', () => {
    expect(parseEnv('A=1\n# c\nexport B="two words"\nC=x # note\n')).toEqual({ A: '1', B: 'two words', C: 'x' });
    const f = join(dir, '.env'); setEnvValue('SAM_API_KEY', 'abc123', f); setEnvValue('OTHER', 'z', f); setEnvValue('SAM_API_KEY', 'changed', f);
    expect(readFileSync(f, 'utf8')).toBe('SAM_API_KEY=changed\nOTHER=z\n'); if (process.platform !== 'win32') expect(statSync(f).mode & 0o077).toBe(0);
    expect(() => setEnvValue('K', 'a\nb', f)).toThrow();
  });
  it('cron honours the configured time zone and catches up after sleep', () => {
    const now = new Date('2026-11-09T11:05:00Z');          // 06:05 in New York (EST)
    expect(isDueTz('0 6 * * *', new Date('2026-11-08T11:00:00Z'), now, 'America/New_York')).toBe(true);
    expect(isDueTz('0 6 * * *', new Date('2026-11-09T11:01:00Z'), now, 'America/New_York')).toBe(false);
    expect(nextRuns('0 6 * * *', 'America/New_York', now, 2)[0].toISOString()).toBe('2026-11-10T11:00:00.000Z');
  });
  it('generates scheduler files for the OS tools', () => {
    expect(simpleDaily('30 7 * * *')).toEqual({ minute: 30, hour: 7 }); expect(simpleDaily('*/5 * * * *')).toBeNull();
    expect(plist('/usr/bin/node', '/x/bin/govcon.mjs', { minute: 0, hour: 6 }, '/x', '/x/logs')).toContain('<key>Hour</key><integer>6</integer>');
    expect(systemdUnits('/usr/bin/node', '/x/govcon.mjs', { minute: 5, hour: 6 }, 'America/New_York', '/x').timer).toContain('OnCalendar=*-*-* 06:05:00 America/New_York');
  });
});
