import { describe, it, expect, beforeAll } from 'vitest';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { tmp, memDb, profile } from './helpers.ts';
import { upsert, parseOpp } from '../src/pipeline/store.ts';
import { runPipeline } from '../src/pipeline/run.ts';
import { Db } from '../src/db.ts';
import { validateWorkbook } from '../src/pipeline/report.ts';
import type { Candidate, Connector } from '../src/types.ts';

const th = { dateDays: 14, valuePct: 20 };
const cand = (o: Partial<Candidate> = {}): Candidate => ({ source: 'sam_notice', sourceId: 'n1', title: 'Cloud migration services', department: 'DHS', agency: 'CBP', subagency: '', solicitationNumber: 'ABC-123-456', solDate: '2027-01-01', solBasis: 'government', ...o });
describe('canonical store', () => {
  it('merges the same solicitation seen by two sources into one record with provenance', () => {
    const db = memDb(); db.run(`insert into run(id) values (1)`);
    const a = upsert(db, cand(), 1, th); const b = upsert(db, cand({ source: 'gsa_forecast', sourceId: 'F9', solicitationNumber: 'ABC 123/456', solDate: '2027-03-01', solBasis: 'government_estimate', valueUsd: 5e6 }), 1, th);
    expect(b.id).toBe(a.id); expect(b.via).toBe('solicitation number');
    const o = parseOpp(db.get(`select * from opp where id=?`, [a.id])!); expect(o.sources.sort()).toEqual(['gsa_forecast', 'sam_notice']);
    expect(o.sol_date).toBe('2027-01-01');                                   // government-posted beats agency estimate
    expect(o.fields.conflicts.some((c: any) => c.field === 'sol_date')).toBe(true);
    expect(o.value_usd).toBe(5e6);                                           // first fill-in of an empty field
  });
  it('detects material changes only above thresholds', () => {
    const db = memDb(); db.run(`insert into run(id) values (1),(2)`);
    upsert(db, cand({ valueUsd: 1e6 }), 1, th);
    const small = upsert(db, cand({ valueUsd: 1.1e6, solDate: '2027-01-05' }), 2, th); expect(small.changes.every((c) => !c.material)).toBe(true);
    const big = upsert(db, cand({ valueUsd: 3e6, solDate: '2027-05-05' }), 2, th); expect(big.changes.filter((c) => c.material).map((c) => c.field).sort()).toEqual(['sol_date', 'value_usd']);
  });
  it('upgrades classification but never downgrades it', () => {
    const db = memDb(); db.run(`insert into run(id) values (1)`);
    const a = upsert(db, cand({ classHint: 'likely_recompete' }), 1, th); upsert(db, cand({ classHint: 'new_requirement' }), 1, th); upsert(db, cand({ classHint: 'confirmed_recompete' }), 1, th);
    expect(db.get(`select classification c from opp where id=?`, [a.id])!.c).toBe('confirmed_recompete');
  });
});

describe('full pipeline on synthetic data (offline)', () => {
  let dir: string; let db: Db;
  beforeAll(() => { dir = tmp(); db = new Db(join(dir, 't.sqlite')); });
  it('day 1 builds a valid 7-sheet workbook; day 2 reports new, changed and vanished records', async () => {
    const now = new Date('2026-11-09T12:00:00Z');
    const s1 = await runPipeline({ demo: true, db, profile: profile(), reportDir: join(dir, 'r'), now, sampleStep: 1, sampleAnchor: '2026-11-09' });
    expect(s1.status).toBe('complete'); expect(s1.counts.report_rows).toBeGreaterThan(30); expect(existsSync(s1.file!)).toBe(true);
    expect((s1.validation as any).ok).toBe(true); expect(await validateWorkbook(s1.file!, { masterRows: s1.counts.report_rows })).toMatchObject({ ok: true });
    const s2 = await runPipeline({ demo: true, db, profile: profile(), reportDir: join(dir, 'r'), now: new Date(now.getTime() + 864e5), sampleStep: 2, sampleAnchor: '2026-11-09' });
    expect(s2.counts.new).toBe(3); expect(s2.counts.changed_fields).toBeGreaterThanOrEqual(3);
    expect(s2.counts.cancelled).toBeGreaterThanOrEqual(1); expect(s2.counts.no_longer_matched).toBeGreaterThanOrEqual(1);
    const ch = db.all(`select kind from change where run_id=?`, [s2.runId]).map((r) => r.kind); expect(ch).toContain('new'); expect(ch).toContain('changed'); expect(ch).toContain('cancelled');
  });
  it('a failing source makes the run PARTIAL and does not mark its records as gone', async () => {
    const d2 = new Db(':memory:'); const ok: Connector = { id: 'sam_notice', name: 'SAM.gov opportunities', access: 'key', async discover() { return { candidates: [cand({ title: 'Cloud migration for CBP', description: 'cloud migration' })], coverage: { source: 'SAM.gov opportunities', status: 'ok', detail: 'ok', fetched: 1 } }; } };
    const bad: Connector = { id: 'sam_notice', name: 'SAM.gov opportunities', access: 'key', async discover() { throw new Error('HTTP 503'); } };
    const other: Connector = { id: 'usaspending_award', name: 'USAspending expiring contracts', access: 'public', async discover() { return { candidates: [], coverage: { source: 'USAspending expiring contracts', status: 'ok', detail: 'ok' } }; } };
    const r1 = await runPipeline({ db: d2, profile: profile(), connectors: [ok, other], reportDir: join(dir, 'r2'), skipGao: true });
    expect(r1.status).toBe('complete');
    const r2 = await runPipeline({ db: d2, profile: profile(), connectors: [bad, other], reportDir: join(dir, 'r2'), skipGao: true });
    expect(r2.status).toBe('partial'); expect(r2.coverage.find((c) => c.source === 'SAM.gov opportunities')!.status).toBe('failed');
    expect(d2.get(`select lifecycle l from opp limit 1`)!.l).toBe('active');
    expect(r2.counts.unverified_absent).toBeGreaterThanOrEqual(1);
  });
  it('dry run saves nothing', async () => {
    const d3 = new Db(':memory:');
    const s = await runPipeline({ demo: true, dryRun: true, db: d3, profile: profile(), reportDir: join(dir, 'r3'), sampleAnchor: '2026-11-09' });
    expect(s.dryRun).toBe(true); expect(d3.get(`select count(*) n from opp`)!.n).toBe(0); expect(d3.get(`select count(*) n from run`)!.n).toBe(0);
  });
});
