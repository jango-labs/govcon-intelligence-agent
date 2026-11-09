import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSam, candidateFromNotice, samUrl, samConnector } from '../src/connectors/sam.ts';
import { candidatesFromCsv, parseCsv } from '../src/connectors/csv.ts';
import { parseRss, pullGao } from '../src/connectors/gao.ts';
import { rangeLowerBound } from '../src/connectors/shared.ts';
import { citedPiids } from '../src/pipeline/predecessor.ts';
import { memDb, profile } from './helpers.ts';
import { redactText } from '../src/util/log.ts';
import { getSecret } from '../src/secrets.ts';

afterEach(() => { vi.unstubAllGlobals(); });
const fx = JSON.parse(readFileSync(new URL('./fixtures/sam-response.json', import.meta.url), 'utf8'));
describe('SAM.gov connector', () => {
  it('parses notices and builds candidates with record links', () => {
    const { notices } = parseSam(fx); const c = candidateFromNotice(notices[0])!;
    expect(c).toMatchObject({ department: 'DHS', agency: 'CBP', solBasis: 'government', urlKind: 'record' }); expect(c.url).toContain('sam.gov/opp/');
  });
  it('builds URLs with the key only in the query and never in errors', async () => {
    expect(samUrl({ keyword: 'cloud' }, 'KEY123')).toContain('api_key=KEY123');
    vi.stubGlobal('fetch', vi.fn(async (u: string) => new Response('boom ' + u, { status: 403 })));
    const prof = profile(); prof.sources.sam.maxCalls = 2;
    const r = await samConnector.discover({ profile: prof, keywords: ['cloud'], window: { from: '', to: '' }, today: '2026-11-09', db: memDb(), getSecret: async () => 'SUPERSECRETKEY1234567890', log: () => {} });
    expect(r.coverage.status).toBe('failed'); expect(JSON.stringify(r)).not.toContain('SUPERSECRETKEY');
  });
  it('is skipped (not failed) without a key and filters award notices', async () => {
    const none = await samConnector.discover({ profile: profile(), keywords: ['cloud'], window: { from: '', to: '' }, today: '2026-11-09', db: memDb(), getSecret: async () => null, log: () => {} });
    expect(none.coverage.status).toBe('skipped');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(fx), { status: 200 })));
    const prof = profile(); prof.sources.sam.fetchDescriptions = 0;
    const r = await samConnector.discover({ profile: prof, keywords: ['cloud'], window: { from: '', to: '' }, today: '2026-11-09', db: memDb(), getSecret: async () => 'k'.repeat(30), log: () => {} });
    const ids = r.candidates.map((c) => c.sourceId); expect(ids).toContain('aaaaaaaa11111111aaaaaaaa11111111'); expect(ids).not.toContain('cccccccc33333333cccccccc33333333');
    expect(r.candidates.every((c) => c.department === 'DHS' || c.department === 'DoD')).toBe(true);
  });
});
describe('CSV import', () => {
  it('parses quoted fields and maps common headers', () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi"""\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"']]);
    const c = candidatesFromCsv('Opportunity Name,Agency,Estimated Value,Solicitation Date,Incumbent\n"Cloud, Data",Army,"$1,500,000",2027-02-01,Example Co\n', 'f.csv');
    expect(c[0]).toMatchObject({ title: 'Cloud, Data', department: 'DoD', valueUsd: 1500000, solDate: '2027-02-01', classHint: 'likely_recompete' }); expect(c[0].incumbent?.name).toBe('Example Co');
  });
});
describe('GAO / helpers', () => {
  it('parses RSS and keeps relevant reports', async () => {
    const xml = `<rss><channel><item><title>IT Modernization Acquisition Needs Oversight</title><link>https://www.gao.gov/products/gao-26-100</link><description>cloud and software</description><pubDate>Mon, 02 Nov 2026 10:00:00 EST</pubDate></item><item><title>Wildlife report</title><link>https://www.gao.gov/products/gao-26-101</link><description>birds</description></item><item><title>Evil cloud</title><link>https://evil.example/x</link><description>cloud</description></item></channel></rss>`;
    expect(parseRss(xml)).toHaveLength(3); const db = memDb(); const r = await pullGao(db, { xml }); expect(r.created).toBe(1); expect((await pullGao(db, { xml })).created).toBe(0);
  });
  it('range lower bounds, PIID citations and log redaction', () => {
    expect(rangeLowerBound('$2M to $5M')).toBe(2e6); expect(rangeLowerBound('Over $100M')).toBe(1e8);
    expect(citedPiids('This is the follow-on to current contract HC102823D0004 awarded in 2023')[0]).toEqual({ piid: 'HC102823D0004', context: true });
    expect(redactText('GET https://api.sam.gov/x?api_key=abcdef123456&limit=1')).toBe('GET https://api.sam.gov/x?api_key=[redacted]&limit=1');
  });
  it('secrets resolve from the environment and are absent otherwise', async () => { process.env.SAM_API_KEY = 'x'.repeat(32); expect(await getSecret('SAM_API_KEY')).toHaveLength(32); delete process.env.SAM_API_KEY; expect(await getSecret('SAM_API_KEY')).toBeNull(); });
});
