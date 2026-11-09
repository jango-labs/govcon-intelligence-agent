// USAspending.gov (official federal award data). Public API, no key required: https://api.usaspending.gov/
// Used for (1) contracts expiring inside the window = recompete / incumbent evidence and (2) looking up a contract number cited in a notice.
import { fetchData } from '../util/http.ts';
import { normalizeOrg } from '../scope.ts';
import type { Connector, Candidate, DiscoverContext, Incumbent } from '../types.ts';
import type { Db } from '../db.ts';

const BASE = () => (process.env.GOVCON_USASPENDING_URL ?? 'https://api.usaspending.gov/api/v2').replace(/\/$/, '');
export const AWARD_URL = (genId: string) => `https://www.usaspending.gov/award/${encodeURIComponent(genId)}`;
const CONTRACT_TYPES = ['A', 'B', 'C', 'D'];            // BPA calls, purchase orders, delivery/task orders, definitive contracts

export interface AwardHit { generatedId: string; piid: string; recipient: string; agency: string; subAgency: string; amount: number | null; description: string; start: string | null; end: string | null; awardType: string | null; naics: string | null; psc: string | null }
const hitOf = (x: any): AwardHit => ({ generatedId: x.generated_internal_id, piid: x['Award ID'], recipient: x['Recipient Name'], agency: x['Awarding Agency'], subAgency: x['Awarding Sub Agency'],
  amount: x['Award Amount'] ?? null, description: x['Description'] ?? '', start: x['Start Date'] ?? null, end: x['End Date'] ?? null, awardType: x['Contract Award Type'] ?? null,
  naics: x['NAICS']?.code ?? null, psc: x['PSC']?.code ?? null });

export async function searchAwards(p: { keywords?: string[]; awardIds?: string[]; naics?: string[]; start: string; end: string; limit?: number; page?: number; sort?: string; order?: 'asc' | 'desc' }, db?: Db) {
  const filters: Record<string, unknown> = { award_type_codes: CONTRACT_TYPES, time_period: [{ start_date: p.start, end_date: p.end }] };
  if (p.keywords?.length) filters.keywords = p.keywords; if (p.awardIds?.length) filters.award_ids = p.awardIds; if (p.naics?.length) filters.naics_codes = p.naics;
  const body = { filters, limit: p.limit ?? 50, page: p.page ?? 1, sort: p.sort ?? 'End Date', order: p.order ?? 'desc',
    fields: ['Award ID', 'Recipient Name', 'Awarding Agency', 'Awarding Sub Agency', 'Award Amount', 'Description', 'Start Date', 'End Date', 'generated_internal_id', 'Contract Award Type', 'NAICS', 'PSC'] };
  const r = await fetchData<any>(`${BASE()}/search/spending_by_award/`, { method: 'POST', body, cacheTtlSec: 3600, minIntervalMs: 300, db });
  return { hits: ((r.data.results ?? []) as any[]).map(hitOf), hasNext: !!r.data.page_metadata?.hasNext };
}
export interface AwardDetail { generatedId: string; piid: string; recipient: string; uei: string | null; totalObligation: number | null; baseAndAllOptions: number | null; dateSigned: string | null; popStart: string | null; popEnd: string | null; potentialEnd: string | null; parentPiid: string | null; setAside: string | null; extentCompeted: string | null; naics: string | null; psc: string | null; url: string }
export async function getAward(genId: string, db?: Db): Promise<AwardDetail> {
  const r = await fetchData<any>(`${BASE()}/awards/${encodeURIComponent(genId)}/`, { cacheTtlSec: 3600, minIntervalMs: 300, db });
  const d = r.data, t = d.latest_transaction_contract_data ?? {}, pop = d.period_of_performance ?? {};
  return { generatedId: d.generated_unique_award_id ?? genId, piid: d.piid, recipient: d.recipient?.recipient_name, uei: d.recipient?.recipient_uei ?? null, totalObligation: d.total_obligation ?? null, baseAndAllOptions: d.base_and_all_options ?? null,
    dateSigned: d.date_signed ?? null, popStart: pop.start_date ?? null, popEnd: pop.end_date ?? null, potentialEnd: pop.potential_end_date ?? null, parentPiid: d.parent_award?.piid ?? null,
    setAside: t.type_set_aside_description ?? null, extentCompeted: t.extent_competed_description ?? null, naics: t.naics ?? null, psc: t.product_or_service_code ?? null, url: AWARD_URL(genId) };
}
export const toIncumbent = (h: AwardHit, d?: AwardDetail): Incumbent => ({
  name: h.recipient, uei: d?.uei ?? undefined, piid: h.piid, parentVehicle: d?.parentPiid ?? undefined, genId: h.generatedId, url: AWARD_URL(h.generatedId),
  value: d?.baseAndAllOptions ?? undefined, valueType: d?.baseAndAllOptions != null ? 'base and all options (USAspending; ceiling, not obligations)' : undefined,
  awardDate: d?.dateSigned ?? h.start ?? undefined, endDate: (d?.potentialEnd ?? h.end) ?? undefined,
  obligations: d?.totalObligation ?? h.amount, obligationsAsOf: new Date().toISOString().slice(0, 10), obligationsSource: 'USAspending.gov (official)', source: 'USAspending.gov award record' });

/** USAspending descriptions are usually ALL CAPS; make them readable without changing the words. */
export const tidy = (s: string) => ((s.match(/[A-Z]/g)?.length ?? 0) / Math.max(1, s.match(/[A-Za-z]/g)?.length ?? 1) > 0.7 ? s.toLowerCase().replace(/(^|[.:;]\s+|\s-\s)([a-z])/g, (_m, a, b) => a + b.toUpperCase()).replace(/\b(it|ai|aws|cdc|dhs|dod|va|cbp|ice|tsa|fema|uscis|nih|cms|fbi|dea|ocio|gsa|api|ot|ml|saas|paas|iaas)\b/g, (m) => m.toUpperCase()) : s);
export function candidateFromAward(h: AwardHit): Candidate {
  const org = normalizeOrg(h.agency, h.subAgency);
  return { source: 'usaspending_award', sourceId: h.generatedId, url: AWARD_URL(h.generatedId), urlKind: 'record', piid: h.piid,
    title: `Expiring contract: ${tidy(h.description.slice(0, 160)) || h.piid}`, description: h.description, department: org.department ?? h.agency, agency: org.department ? org.agency : h.agency, subagency: org.department ? org.subagency : h.subAgency,
    naics: h.naics ?? undefined, psc: h.psc ?? undefined, instrument: h.awardType ?? undefined, status: `Contract period ends ${h.end}`, stage: 'expiring_award',
    incumbent: toIncumbent(h), classHint: 'expiring_no_followon', classEvidence: 'contract period of performance ends inside the window (USAspending); expiration alone does not prove a recompete',
    other: `Incumbent: ${h.recipient} • Contract ${h.piid}`, raw: h };
}

export const usaspendingConnector: Connector = {
  id: 'usaspending_award', name: 'USAspending expiring contracts', access: 'public',
  async discover(ctx: DiscoverContext) {
    const NAME = 'USAspending expiring contracts'; const cfg = ctx.profile.sources.usaspending;
    if (!cfg.enabled || !cfg.expiringContracts) return { candidates: [], coverage: { source: NAME, status: 'skipped', detail: 'disabled in profile' } };
    const out = new Map<string, Candidate>(); let calls = 0, failed = 0, capped = false, scanned = 0; let err = '';
    const today = ctx.today; const lim = new Date(today + 'T00:00:00Z'); lim.setUTCMonth(lim.getUTCMonth() + cfg.expiringWithinMonths); const limit = lim.toISOString().slice(0, 10);
    const startD = new Date(today + 'T00:00:00Z'); startD.setUTCFullYear(startD.getUTCFullYear() - cfg.lookbackYears);
    const naics = ctx.profile.filters.naicsMode === 'require' ? ctx.profile.filters.naics : undefined;
    outer: for (const kw of ctx.keywords.slice(0, cfg.maxKeywords)) {
      for (let page = 1; page <= 6; page++) {
        if (calls >= cfg.maxCalls) { capped = true; break outer; }
        calls++;
        try {
          const r = await searchAwards({ keywords: [kw], naics, start: startD.toISOString().slice(0, 10), end: today, limit: 100, page }, ctx.db);
          scanned += r.hits.length; let past = false;
          for (const h of r.hits) { if (!h.end) continue; if (h.end < today) { past = true; continue; } if (h.end > limit) continue; if (!out.has(h.generatedId)) out.set(h.generatedId, candidateFromAward(h)); }
          if (past || !r.hasNext) break;                    // sorted by end date descending: once results are in the past, later pages are older
        } catch (e) { failed++; err = (e as Error).message; break; }
      }
    }
    const status = failed && !out.size ? 'failed' : failed || capped ? 'partial' : 'ok';
    return { candidates: [...out.values()], coverage: { source: NAME, status, detail: `${Math.min(ctx.keywords.length, cfg.maxKeywords)} keyword searches, ${calls} request(s) (ceiling ${cfg.maxCalls}), ${scanned} awards scanned, ${out.size} contracts ending ${today} → ${limit}${failed ? `; ${failed} failed (${err.slice(0, 120)})` : ''}${capped ? '; stopped at the request ceiling — raise sources.usaspending.maxCalls for deeper coverage' : ''}. Keyword search covers award descriptions; coverage is not exhaustive.`, fetched: out.size, calls } };
  },
};

/** Look up a contract number (PIID) in USAspending; returns the incumbent record or null. */
export async function lookupPiid(piid: string, today: string, db?: Db): Promise<{ hit: AwardHit; detail?: AwardDetail } | null> {
  const r = await searchAwards({ awardIds: [piid], start: '2007-10-01', end: today, limit: 5, sort: 'Award Amount' }, db);
  const hit = r.hits.find((h) => String(h.piid).replace(/-/g, '') === piid.replace(/-/g, '')) ?? null; if (!hit) return null;
  let detail: AwardDetail | undefined; try { detail = await getAward(hit.generatedId, db); } catch { /* summary only */ }
  return { hit, detail };
}
