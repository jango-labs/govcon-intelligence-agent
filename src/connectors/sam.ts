// SAM.gov Get Opportunities Public API v2 (https://open.gsa.gov/api/get-opportunities-public-api/). Needs the installer's OWN free API key.
// The key is read at call time, never logged (URLs are redacted in errors), never stored in the database or reports.
import { fetchData, HttpError } from '../util/http.ts';
import { redactText } from '../util/log.ts';
import { normalizeOrg, inScope } from '../scope.ts';
import type { Connector, Candidate, SourceCoverage, DiscoverContext } from '../types.ts';
import type { Db } from '../db.ts';

const BASE = () => process.env.GOVCON_SAM_URL ?? 'https://api.sam.gov/opportunities/v2/search';
const mdY = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
const toDate = (v: unknown): string | null => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? '')); return m ? m[1] : null; };

export interface SamQuery { keyword?: string; ncode?: string; solnum?: string; noticeid?: string; ptype?: string; postedFrom?: Date; postedTo?: Date; limit?: number; offset?: number }
export interface SamNotice {
  noticeId: string; title: string; solicitationNumber: string | null; department: string | null; subTier: string | null; office: string | null; postedDate: string | null; type: string | null; baseType: string | null;
  naics: string | null; psc: string | null; active: boolean; responseDeadline: string | null; setAside: string | null; uiLink: string | null; descriptionUrl: string | null; raw: any;
}
export class SamError extends Error { status: number; constructor(status: number, msg: string) { super(redactText(msg)); this.status = status; } }

export function samUrl(p: SamQuery, key: string): string {
  const u = new URL(BASE()); const to = p.postedTo ?? new Date(); const from = p.postedFrom ?? new Date(to.getTime() - 30 * 864e5);
  const set = (k: string, v: string | number | undefined) => { if (v !== undefined && v !== '') u.searchParams.set(k, String(v)); };
  set('api_key', key); set('postedFrom', mdY(from)); set('postedTo', mdY(to)); set('limit', p.limit ?? 25); set('offset', p.offset ?? 0);
  set('title', p.keyword); set('ncode', p.ncode); set('solnum', p.solnum); set('noticeid', p.noticeid); set('ptype', p.ptype);
  return u.toString();
}
export function parseSam(data: any): { notices: SamNotice[]; total: number } {
  const list: any[] = data?.opportunitiesData ?? [];
  return { total: Number(data?.totalRecords ?? list.length), notices: list.map((n) => ({
    noticeId: n.noticeId, title: n.title, solicitationNumber: n.solicitationNumber ?? null, department: n.fullParentPathName?.split('.')[0] ?? n.department ?? null, subTier: n.subTier ?? null, office: n.office ?? null,
    postedDate: n.postedDate ?? null, type: n.type ?? null, baseType: n.baseType ?? null, naics: n.naicsCode ?? null, psc: n.classificationCode ?? null,
    active: String(n.active).toLowerCase() === 'yes', responseDeadline: n.responseDeadLine ?? null, setAside: n.typeOfSetAsideDescription ?? null, uiLink: n.uiLink ?? null,
    descriptionUrl: typeof n.description === 'string' && n.description.startsWith('http') ? n.description : null, raw: n })) };
}
export async function searchSam(p: SamQuery, key: string, db?: Db, noCache = false) {
  try {
    const r = await fetchData<any>(samUrl(p, key), { cacheTtlSec: 900, minIntervalMs: 1000, db, noCache, retries: 2 });
    return { ...parseSam(r.data), fetchedAt: r.fetchedAt };
  } catch (e) { throw new SamError(e instanceof HttpError ? e.status : -1, (e as Error).message.split(key).join('[redacted]')); }
}
export async function fetchSamDescription(url: string, key: string, db?: Db): Promise<string> {
  const u = new URL(url); if (!/(^|\.)sam\.gov$/.test(u.hostname)) throw new Error('refusing to send the SAM.gov key to a non-SAM host'); u.searchParams.set('api_key', key);
  const r = await fetchData<any>(u.toString(), { cacheTtlSec: 86400, minIntervalMs: 1000, db, retries: 1 });
  return String(r.data?.description ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}
export async function testSam(key: string): Promise<{ ok: boolean; detail: string }> {
  try { const r = await searchSam({ limit: 1, postedFrom: new Date(Date.now() - 7 * 864e5) }, key, undefined, true); return { ok: true, detail: `SAM.gov responded: ${r.total} notices posted in the last 7 days` }; }
  catch (e) { const se = e as SamError; return { ok: false, detail: se.status === 401 || se.status === 403 ? `SAM.gov rejected the key (HTTP ${se.status}). Check that you copied the Public API Key and that it is not expired.` : se.status === 429 ? 'SAM.gov rate limit reached; the key quota resets daily.' : se.message }; }
}

const SKIP_TYPES = /^(award notice|justification|intent to bundle|sale of surplus|consolidate\/\(substantially\) bundle)/i;
export function candidateFromNotice(n: SamNotice, description = ''): Candidate | null {
  const path = String(n.raw?.fullParentPathName ?? '').split('.').map((x) => x.trim()).filter(Boolean);
  const org = normalizeOrg(...path, n.department, n.subTier);
  const stage = String(n.type ?? n.baseType ?? ''); const rd = n.responseDeadline ? new Date(n.responseDeadline) : null;
  const released = /solicitation|combined/i.test(stage) ? toDate(n.postedDate) : null;
  return { source: 'sam_notice', sourceId: n.noticeId, url: n.uiLink ?? undefined, urlKind: n.uiLink ? 'record' : 'none', updated: n.postedDate ?? null, solicitationNumber: n.solicitationNumber ?? undefined,
    title: n.title, description, department: org.department, agency: org.agency || (path[0] ?? ''), subagency: org.subagency || (n.office ?? ''),
    solDate: released, solBasis: released ? 'government' : 'unknown', awardBasis: 'unknown', setAside: n.setAside ?? undefined, naics: n.naics ?? undefined, psc: n.psc ?? undefined,
    status: `${stage || 'Notice'}${rd ? ` – responses due ${toDate(n.responseDeadline)}` : ''}`, stage, raw: n.raw };
}

export const samConnector: Connector = {
  id: 'sam_notice', name: 'SAM.gov opportunities', access: 'key',
  async discover(ctx: DiscoverContext) {
    const NAME = 'SAM.gov opportunities'; const cfg = ctx.profile.sources.sam;
    if (!cfg.enabled) return { candidates: [], coverage: { source: NAME, status: 'skipped', detail: 'disabled in profile' } };
    const key = await ctx.getSecret('SAM_API_KEY');
    if (!key) return { candidates: [], coverage: { source: NAME, status: 'skipped', detail: 'no SAM_API_KEY configured (free key: see README → "Get a SAM.gov API key"); public sources still ran' } };
    const seen = new Map<string, Candidate>(); const nn = new Map<string, SamNotice>();
    let calls = 0, failed = 0, capped = false, raw = 0, stopped = '';
    const from = new Date(Date.now() - cfg.lookbackDays * 864e5), to = new Date();
    const wantTypes = ctx.profile.filters.noticeTypes.map((t) => t.toLowerCase());
    outer: for (const term of ctx.keywords) {
      for (let offset = 0; offset < 5000; offset += 1000) {
        if (calls >= cfg.maxCalls) { capped = true; break outer; }
        calls++;
        let r: Awaited<ReturnType<typeof searchSam>>;
        try { r = await searchSam({ keyword: term, postedFrom: from, postedTo: to, limit: 1000, offset }, key, ctx.db); }
        catch (e) { failed++; const se = e as SamError; if ([401, 403, 429].includes(se.status)) { stopped = se.status === 429 ? 'SAM.gov rate limit reached (quota resets daily)' : `SAM.gov rejected the key (HTTP ${se.status})`; break outer; } break; }
        raw += r.notices.length;
        for (const n of r.notices) {
          if (!n.active || nn.has(n.noticeId)) continue;
          const rd = n.responseDeadline ? new Date(n.responseDeadline) : null; if (rd && rd.getTime() < Date.now() - 864e5) continue;
          const stage = String(n.type ?? n.baseType ?? '');
          if (wantTypes.length ? !wantTypes.some((t) => stage.toLowerCase().includes(t)) : SKIP_TYPES.test(stage)) continue;
          nn.set(n.noticeId, n);
        }
        if (r.notices.length < 1000) break;
      }
    }
    // optional description text (one extra call each, capped): only for notices that already pass scope
    let descCalls = 0;
    for (const n of nn.values()) {
      let d = '';
      const c0 = candidateFromNotice(n); if (!c0 || !inScope({ department: c0.department, agency: c0.agency, subagency: c0.subagency }, ctx.profile.scope.departments)) continue;
      if (n.descriptionUrl && descCalls < cfg.fetchDescriptions && !stopped) { descCalls++; try { d = await fetchSamDescription(n.descriptionUrl, key, ctx.db); } catch { /* title-only is acceptable */ } }
      seen.set(n.noticeId, candidateFromNotice(n, d)!);
    }
    const status: SourceCoverage['status'] = stopped || (capped && !seen.size) ? 'failed' : failed || capped ? 'partial' : 'ok';
    return { candidates: [...seen.values()], coverage: { source: NAME, status, detail: `${ctx.keywords.length} keyword title searches, ${calls} request(s) (ceiling ${cfg.maxCalls}), ${raw} notices returned, ${seen.size} active in-scope notices, ${descCalls} description fetches${failed ? `, ${failed} failed` : ''}${capped ? '; stopped at the per-run request ceiling' : ''}${stopped ? '; ' + stopped : ''}. SAM matches titles only.`, fetched: seen.size, calls: calls + descCalls } };
  },
};
