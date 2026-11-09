// GSA Acquisition Gateway Forecast Tool (nationwide agency forecasts, ~12,000 records from every agency that publishes there). The public page reads an anonymous JSON listing
// (ag-dashboard.acquisitiongateway.gov/api/v3.0/resources/forecast, paged with range/page); there is no documented API, so this reads exactly that feed, a page at a time,
// politely and identifying itself. A feed that stops answering or returns fewer rows than it promised is reported as partial/failed, never as "no forecasts".
import { logger } from '../util/log.ts';
import { USER_AGENT } from '../util/http.ts';
import { normalizeOrg } from '../scope.ts';
import { classHint, rangeLowerBound } from './shared.ts';
import type { Candidate, Connector, DiscoverContext } from '../types.ts';

export const gsaBase = () => (process.env.GOVCON_GSA_URL ?? 'https://ag-dashboard.acquisitiongateway.gov/api/v3.0/resources/forecast').replace(/\/$/, '');
const ent = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
const text = (html: unknown) => ent(String(html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
const isoOf = (html: unknown): string[] => [...String(html ?? '').matchAll(/datetime="(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
const AG_ID = /^AG\d+_\d+$/;

export function candidateFromGsa(r: any, base = 'https://acquisitiongateway.gov'): Candidate | null {
  const d = r?.render; if (!d || !r.nid) return null;
  const agencyName = text(d.field_result_id), office = text(d.field_funding_organization);
  const org = normalizeOrg(agencyName, office);
  const naics = /(\d{6})/.exec(String(d.field_naics_code ?? ''))?.[1]; const naicsLabel = text(String(d.field_naics_code ?? '').replace(/^[\s\S]*?field--name-name[^>]*>\s*\d{6}\s*<[\s\S]*?field--name-field-label[^>]*>/, '')).slice(0, 120);
  const range = text(d.field_estimated_contract_v_max); const lower = /^below/i.test(range) ? null : rangeLowerBound(range);
  const dates = isoOf(d.field_period_of_performance); const start = dates[0] ?? null, end = dates[1] ?? null;
  const fy = Number(String(d.field_estimated_award_fy ?? '').trim()) || undefined; const stage = text(d.field_award_status);
  const strategy = text(d.field_acquisition_strategy); const body = text(d.body); const own = text(d.field_source_listing_id);
  const set = /small business|set-?aside|8\(a\)|veteran|hubzone|wosb|edwosb|isbee|sdvosb/i.test(strategy) ? strategy : undefined;
  const awarded = /^awarded$/i.test(stage); const option = /option/i.test(stage);
  const hint = classHint(`${body} ${text(d.title)}`);
  const place = text(d.field_place_of_performance).replace(/\s+/g, ' ');
  return {
    source: 'gsa_forecast', sourceId: `AGF-${r.nid}`, solicitationNumber: own && !AG_ID.test(own) ? own : undefined, url: `${base}/forecast`, urlKind: 'listing', updated: null,
    title: text(d.title), description: body, department: org.department ?? (agencyName.replace(/^department of( the)? /i, 'Dept. of ') || null), agency: org.department ? org.agency : (office || agencyName), subagency: org.department ? org.subagency || office : '',
    solDate: null, solBasis: 'unknown', awardDate: start, awardBasis: start ? 'performance_start' : 'unknown', fiscalYear: fy,
    valueUsd: lower, valueType: lower == null ? undefined : `agency dollar range, lower bound ("${range}")`, valueNote: range ? `Acquisition Gateway range "${range}"${lower != null ? '; the figure counted is its lower bound' : ''}` : undefined,
    setAside: set, instrument: text(d.field_contract_type) || undefined, naics, status: `${stage || 'Forecast'}${fy ? ` (FY${fy})` : ''}${awarded ? ' — already awarded' : ''}`, stage: 'forecast',
    duration: start && end ? `${start} to ${end}` : start ?? undefined,
    classHint: option ? 'likely_recompete' : hint.classHint === 'unknown' ? 'new_requirement' : hint.classHint,
    classEvidence: option ? 'the agency lists the stage as "Exercise of Option" (an existing contract)' : hint.classHint !== 'unknown' ? undefined : 'forecast lists no incumbent; treated as a new requirement unless other sources show a predecessor',
    other: [agencyName, office, strategy, place ? `Place of performance: ${place}` : '', naicsLabel, own && !AG_ID.test(own) ? `Agency listing ID: ${own}` : ''].filter(Boolean).join(' | '),
    raw: { nid: r.nid, listing_id: own, award_fy: fy, award_status: stage, pop_start: start, pop_end: end, estimated_value_range: range, agency: agencyName, office, created: isoOf(d.created)[0], changed: isoOf(d.changed)[0] },
  };
}

export const gsaConnector: Connector = {
  id: 'gsa_forecast', name: 'GSA Acquisition Gateway forecast', access: 'public',
  async discover(ctx: DiscoverContext) {
    const NAME = 'GSA Acquisition Gateway forecast'; const cfg = ctx.profile.sources.gsaForecast;
    if (!cfg.enabled) return { candidates: [], coverage: { source: NAME, status: 'skipped', detail: 'disabled in profile' } };
    const pageSize = 100; const seen = new Map<string, Candidate>(); const byAgency = new Map<string, number>();
    let total = 0, pages = 0, err = '', done = false; const conc = Number(process.env.GOVCON_GSA_CONCURRENCY ?? 2);
    const fetchPage = async (page: number): Promise<any[] | null> => {
      for (let i = 0; i < 3; i++) {
        try {
          const res = await fetch(`${gsaBase()}?range=${pageSize}&page=${page}`, { signal: AbortSignal.timeout(90000), headers: { accept: 'application/json', 'user-agent': USER_AGENT } });
          if (!res.ok || !/json/i.test(res.headers.get('content-type') ?? '')) throw new Error(`HTTP ${res.status}`);
          const body: any = await res.json(); if (!body?.listing) throw new Error('no listing in response');
          total = Number(body.listing.total) || total; return body.listing.data ?? [];
        } catch (e) { err = (e as Error).message; await new Promise((r) => setTimeout(r, Number(process.env.GOVCON_GSA_RETRY_MS ?? 1500) * (i + 1))); }
      }
      logger.warn('gsa forecast page failed', { page, err }); return null;
    };
    for (let page = 0; page < cfg.maxPages && !done; page += conc) {
      const batch = await Promise.all(Array.from({ length: Math.min(conc, cfg.maxPages - page) }, (_, i) => fetchPage(page + i)));
      for (const data of batch) {
        if (data === null) { done = true; continue; }
        pages++; if (!data.length) { done = true; err = ''; continue; }
        for (const r of data) { const c = candidateFromGsa(r); if (!c || seen.has(c.sourceId)) continue; seen.set(c.sourceId, c); const k = String(c.department); byAgency.set(k, (byAgency.get(k) ?? 0) + 1); }
      }
      if (total > 0 && seen.size >= total) { done = true; err = ''; } else await new Promise((r) => setTimeout(r, Number(process.env.GOVCON_GSA_PAUSE_MS ?? 250)));
    }
    const got = seen.size; const complete = total > 0 && got >= total;
    const top = [...byAgency.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(', ');
    if (!got) return { candidates: [], coverage: { source: NAME, status: 'failed', detail: `The Acquisition Gateway forecast feed returned no records (${err || 'empty response'}). This is an undocumented public feed and may change; other sources are unaffected.` } };
    return { candidates: [...seen.values()], coverage: { source: NAME, status: complete ? 'ok' : 'partial', detail: `${got} of ${total} forecast records read in ${pages} page(s) (${top}).${complete ? '' : ` Incomplete${err ? ': ' + err : ''}; records not returned are left unchanged, not marked gone.`} Undocumented public feed behind the Acquisition Gateway forecast page; read politely once per run.`, fetched: got, expected: total || undefined, calls: pages } };
  },
};
