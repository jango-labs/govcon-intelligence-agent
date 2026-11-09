// Demo connector: reads the SYNTHETIC records in data/sample/ (all invented). Used by `govcon demo` and the tests; never contacts the network.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../config.ts';
import { normalizeOrg } from '../scope.ts';
import type { Connector, Candidate, DiscoverContext } from '../types.ts';

const addDays = (today: string, d: number) => { const x = new Date(today + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + d); return x.toISOString().slice(0, 10); };
export function loadSample(step: number, today: string): Candidate[] {
  const file = join(paths.sampleDir, step === 1 ? 'opportunities-day1.json' : 'opportunities-day2.json');
  const data = JSON.parse(readFileSync(file, 'utf8')) as { items: any[] };
  return data.items.map((x): Candidate => {
    const org = normalizeOrg(x.department, x.agency, x.subagency);
    const inc = x.incumbent ? { name: x.incumbent.name, piid: x.incumbent.piid, endDate: addDays(today, x.incumbent.endOffsetDays), value: Math.round(x.incumbent.valueUsd), valueType: 'synthetic ceiling', obligations: Math.round(x.incumbent.valueUsd * x.incumbent.obligationsPct), obligationsAsOf: today, obligationsSource: 'synthetic', source: 'synthetic demo data' } : undefined;
    const isAward = x.sourceKind === 'usaspending_award';
    return { source: x.sourceKind === 'gsa_forecast' ? 'gsa_forecast' : x.sourceKind, sourceId: x.id, url: x.url, urlKind: x.urlKind, updated: today + 'T00:00:00Z', solicitationNumber: x.solicitationNumber, piid: x.piid,
      title: x.title, description: x.description, department: org.department, agency: org.agency, subagency: org.subagency || x.subagency,
      solDate: !isAward && x.solOffsetDays != null ? addDays(today, x.solOffsetDays) : null, solBasis: x.solBasis ?? 'unknown', awardDate: !isAward && x.awardOffsetDays != null ? addDays(today, x.awardOffsetDays) : null, awardBasis: isAward ? 'unknown' : 'government_estimate',
      valueUsd: x.valueUsd ?? null, valueType: x.valueType ?? undefined, setAside: x.setAside, instrument: x.instrument, vehicle: x.vehicle, duration: x.duration, naics: x.naics, psc: x.psc, status: x.status, stage: x.stage,
      fiscalYear: x.fiscalYear, incumbent: inc, classHint: x.classHint, classEvidence: x.classEvidence, other: `${x.agency} • ${x.subagency}`, raw: { synthetic: true } };
  });
}
/** step 1 = first demo day, step 2 = the next day (adds changes). Records appear under their real-looking source kinds so merging/ranking behave as in production runs. */
export const sampleConnector = (step = 1, anchor?: string): Connector => ({
  id: 'sample', name: 'Synthetic demo data', access: 'demo',
  async discover(ctx: DiscoverContext) {
    const c = loadSample(step, anchor ?? ctx.today);
    return { candidates: c, coverage: { source: 'Synthetic demo data', status: 'ok', detail: `${c.length} invented records (day ${step}); no network access, no credentials`, fetched: c.length } };
  },
});
