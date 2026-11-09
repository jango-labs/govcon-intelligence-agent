// Natural-language questions over the STORED opportunities. Answers come from the database, never from a model's memory.
// A deterministic parser handles the common question shapes with no AI; an optional model can translate unusual phrasing into the same filter
// schema (validated) and can rephrase the final text under a "no new facts" guard.
import { Db, parseJ } from '../db.ts';
import type { Profile } from '../config.ts';
import { parseOpp } from '../pipeline/store.ts';
import { normalizeOrg, OTHER_DEPTS } from '../scope.ts';
import { getProvider, rephrase, translateToFilter } from './llm.ts';

export interface Filter {
  departments?: string[]; agencies?: string[]; monthsFrom?: number; monthsTo?: number; classifications?: string[]; priorities?: string[];
  minValue?: number; maxValue?: number; keywords?: string[]; naics?: string[]; setAside?: string; sort?: 'priority' | 'release' | 'value'; limit?: number;
  changesDays?: number; text?: string; intent?: 'list' | 'count' | 'changes' | 'health' | 'reports' | 'help' | 'expiring' | 'incumbent';
}
const FILTER_HELP = 'departments[], agencies[], monthsFrom, monthsTo, classifications[] (confirmed_recompete|likely_recompete|possible_followon|expiring_no_followon|new_requirement), priorities[] (High|Medium|Low|Watch), minValue, maxValue, keywords[], naics[], setAside, sort (priority|release|value), limit, changesDays, intent (list|count|changes|health)';
const money = (s: string, u?: string) => { const n = Number(s.replace(/,/g, '')); return n * ({ k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9 } as Record<string, number>)[(u ?? '').toLowerCase()] || n; };

export function parseQuestion(q: string, knownKeywords: string[] = []): Filter {
  const t = q.toLowerCase(); const f: Filter = { intent: 'list' };
  const segs = q.split(/\band\b|,|\bor\b|\/|&/i); const depts = new Set<string>(), ags = new Set<string>();
  for (const s of [q, ...segs]) { const o = normalizeOrg(s.replace(/\bva\b/gi, 'VA')); if (o.department && !/^(opportunit|contract)/i.test(s.trim())) { depts.add(o.department); if (o.agency && !/unspecified|department level/i.test(o.agency)) ags.add(o.agency); } }
  for (const [code, re] of OTHER_DEPTS) if (re.test(q)) depts.add(code);
  if (depts.size) f.departments = [...depts]; if (ags.size) { f.agencies = [...ags]; if (f.departments && ags.size && segs.length === 1) f.departments = undefined; }
  const range = /(?:months?\s+)?(\d+)\s*(?:-|–|to)\s*(\d+)\s*months?|months?\s+(\d+)\s*(?:-|–|to)\s*(\d+)/.exec(t); const next = /(?:next|within|in the next|coming)\s+(\d+)\s*(months?|years?|weeks?|days?)/.exec(t);
  if (range) { f.monthsFrom = Number(range[1] ?? range[3]); f.monthsTo = Number(range[2] ?? range[4]); }
  else if (next) { const n = Number(next[1]); const u = next[2][0]; f.monthsFrom = 0; f.monthsTo = u === 'y' ? n * 12 : u === 'w' ? n / 4.35 : u === 'd' ? n / 30.44 : n; }
  else if (/this quarter/.test(t)) { f.monthsFrom = 0; f.monthsTo = 3; } else if (/this year|next year|next 12/.test(t)) { f.monthsFrom = 0; f.monthsTo = 12; }
  const cl: string[] = [];
  if (/recompete|incumbent|follow[- ]?on|re-?compet/.test(t)) cl.push('confirmed_recompete', 'likely_recompete', 'possible_followon');
  if (/expir/.test(t)) { cl.push('expiring_no_followon'); f.intent = 'expiring'; }
  if (/\bnew (requirement|start|work)|\bnot (a )?recompete|no incumbent/.test(t)) cl.push('new_requirement');
  if (cl.length) f.classifications = [...new Set(cl)];
  const pr: string[] = []; if (/\bhigh(?:est)?[- ]priority|top priority|\bhigh priority/.test(t)) pr.push('High'); if (/\bmedium[- ]priority/.test(t)) pr.push('Medium'); if (/high and medium|high or medium/.test(t)) pr.push('High', 'Medium');
  if (pr.length) f.priorities = [...new Set(pr)];
  const over = /(?:over|above|more than|at least|greater than|>=?)\s*\$?\s*([\d.,]+)\s*(k|m|b|thousand|million|billion)?/.exec(t); const under = /(?:under|below|less than|at most|<=?)\s*\$?\s*([\d.,]+)\s*(k|m|b|thousand|million|billion)?/.exec(t);
  if (over) f.minValue = money(over[1], over[2]); if (under) f.maxValue = money(under[1], under[2]);
  const nx = [...q.matchAll(/\b(\d{6})\b/g)].map((m) => m[1]); if (nx.length) f.naics = nx;
  const sa = /\b(8\(a\)|sdvosb|service[- ]disabled|wosb|edwosb|hubzone|small business|total small|full and open|unrestricted)\b/i.exec(q); if (sa) f.setAside = sa[1];
  const kws = knownKeywords.filter((k) => new RegExp(`(?<![A-Za-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9])`, 'i').test(q)); const quoted = [...q.matchAll(/["“']([^"”']{3,})["”']/g)].map((m) => m[1]);
  const about = /\b(?:about|mention(?:s|ing)?|related to|involving|for|regarding)\s+([a-z0-9][a-z0-9 /&+-]{2,40})/i.exec(q);
  if (kws.length || quoted.length) f.keywords = [...kws, ...quoted]; else if (about && !f.departments && !f.agencies) f.text = about[1].replace(/\b(in|the|over|under|next|within)\b.*$/i, '').trim();
  if (/largest|biggest|highest value|most valuable/.test(t)) f.sort = 'value'; else if (/soonest|earliest|upcoming|first to|next to release|release soon/.test(t)) f.sort = 'release';
  const lim = /\btop\s+(\d+)\b|\b(\d+)\s+(?:opportunit|results)/.exec(t); if (lim) f.limit = Number(lim[1] ?? lim[2]);
  if (/how many|count|number of/.test(t)) f.intent = 'count';
  if (/what('s| is| has)? (new|changed)|changes? (since|in)|new (today|yesterday|this week)|\bwhat changed\b|since (yesterday|last)/.test(t)) { f.intent = 'changes'; f.changesDays = /week|7 days/.test(t) ? 7 : /month/.test(t) ? 30 : 1; }
  if (/source (health|status|coverage)|did .* (fail|run)|last run|run status|partial|is .* (working|down)|data quality/.test(t)) f.intent = 'health';
  if (/\b(report|workbook|excel|spreadsheet)\b/.test(t) && !/mention/.test(t)) f.intent = 'reports';
  if (/\bhelp\b|what can you|how do i ask/.test(t)) f.intent = 'help';
  if (/who (holds|has|is the incumbent)|incumbent (is|for)/.test(t)) f.intent = 'incumbent';
  return f;
}
const ALLOWED_CLASS = new Set(['confirmed_recompete', 'likely_recompete', 'possible_followon', 'expiring_no_followon', 'new_requirement', 'unknown']);
export function sanitizeFilter(x: any): Filter {
  const f: Filter = { intent: 'list' }; if (!x || typeof x !== 'object') return f;
  const arr = (v: any) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string').map((s) => s.slice(0, 80)).slice(0, 10) : undefined); const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
  f.departments = arr(x.departments); f.agencies = arr(x.agencies); f.keywords = arr(x.keywords); f.naics = arr(x.naics)?.filter((n) => /^\d{2,6}$/.test(n));
  f.classifications = arr(x.classifications)?.filter((c) => ALLOWED_CLASS.has(c)); f.priorities = arr(x.priorities)?.filter((p) => ['High', 'Medium', 'Low', 'Watch'].includes(p));
  f.monthsFrom = num(x.monthsFrom); f.monthsTo = num(x.monthsTo); f.minValue = num(x.minValue); f.maxValue = num(x.maxValue); f.limit = Math.min(200, num(x.limit) ?? 25); f.changesDays = num(x.changesDays);
  if (['priority', 'release', 'value'].includes(x.sort)) f.sort = x.sort; if (['list', 'count', 'changes', 'health'].includes(x.intent)) f.intent = x.intent; if (typeof x.setAside === 'string') f.setAside = x.setAside.slice(0, 60);
  return f;
}
const empty = (f: Filter) => !(f.departments || f.agencies || f.monthsTo !== undefined || f.classifications || f.priorities || f.minValue || f.maxValue || f.keywords || f.naics || f.setAside || f.text || (f.intent && f.intent !== 'list'));

export interface AskRow { id: number; title: string; department: string; agency: string; priority: string; score: number | null; release: string | null; releaseBasis: string; value: number | null; classification: string; incumbent: string | null; url: string | null; linkType: string }
export interface Answer { text: string; rows: AskRow[]; filter: Filter; usedModel: boolean; caveats: string[]; total: number }
const fmtUsd = (n: number | null) => (n == null ? 'n/a' : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}K`);
const monthsFromToday = (d: string, today: string) => (new Date(d).getTime() - new Date(today).getTime()) / (30.44 * 864e5);
const BASIS: Record<string, string> = { government: 'posted', government_estimate: 'agency estimate', imported: 'imported', unknown: 'unknown', estimate: 'estimate' };

export function selectRows(db: Db, f: Filter, today = new Date().toISOString().slice(0, 10)): { rows: AskRow[]; total: number } {
  let opps = db.all(`select * from opp where lifecycle='active' and review_state not in ('review','dismissed')`).map(parseOpp);
  if (f.departments?.length) { const d = f.departments.map((x) => x.toLowerCase()); opps = opps.filter((o) => d.includes(String(o.department).toLowerCase())); }
  if (f.agencies?.length) { const a = f.agencies.map((x) => x.toLowerCase()); opps = opps.filter((o) => a.includes(String(o.agency).toLowerCase()) || a.includes(String(o.subagency).toLowerCase())); }
  if (f.classifications?.length) opps = opps.filter((o) => f.classifications!.includes(o.classification));
  if (f.priorities?.length) opps = opps.filter((o) => f.priorities!.includes(o.priority));
  if (f.minValue != null) opps = opps.filter((o) => o.counted_value_usd != null && o.counted_value_usd >= f.minValue!);
  if (f.maxValue != null) opps = opps.filter((o) => o.counted_value_usd != null && o.counted_value_usd <= f.maxValue!);
  if (f.naics?.length) opps = opps.filter((o) => f.naics!.some((n) => String(o.naics ?? '').startsWith(n)));
  if (f.setAside) opps = opps.filter((o) => new RegExp(f.setAside!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(o.set_aside ?? ''));
  if (f.keywords?.length) opps = opps.filter((o) => { const h = `${o.title} ${o.description ?? ''}`.toLowerCase(); return f.keywords!.some((k) => h.includes(k.toLowerCase()) || (o.matched_keywords ?? []).some((m: string) => m.toLowerCase() === k.toLowerCase())); });
  if (f.text) opps = opps.filter((o) => `${o.title} ${o.description ?? ''} ${o.keyword_category ?? ''}`.toLowerCase().includes(f.text!.toLowerCase()));
  if (f.monthsTo !== undefined) opps = opps.filter((o) => { const d = o.sol_date ?? o.fields?.derived_release ?? o.award_date; if (!d) return false; const m = monthsFromToday(d, today); return m >= (f.monthsFrom ?? 0) && m < f.monthsTo!; });
  const sort = f.sort ?? 'priority';
  opps.sort((a, b) => sort === 'value' ? (b.counted_value_usd ?? -1) - (a.counted_value_usd ?? -1) : sort === 'release' ? String(a.sol_date ?? a.fields?.derived_release ?? '9999').localeCompare(String(b.sol_date ?? b.fields?.derived_release ?? '9999')) : (b.priority_score ?? 0) - (a.priority_score ?? 0));
  const rows = opps.slice(0, f.limit ?? 15).map((o): AskRow => ({ id: o.id, title: o.title, department: o.department, agency: o.agency, priority: o.priority, score: o.priority_score, release: o.sol_date ?? o.fields?.derived_release ?? null,
    releaseBasis: o.sol_date ? (BASIS[o.sol_date_basis] ?? o.sol_date_basis) : o.fields?.derived_release ? 'DERIVED estimate' : 'unknown', value: o.value_usd, classification: o.classification, incumbent: o.incumbent?.name ?? null, url: o.primary_url, linkType: o.url_kind ?? 'none' }));
  return { rows, total: opps.length };
}
function describe(f: Filter): string {
  const p: string[] = []; if (f.departments) p.push(f.departments.join('/')); if (f.agencies) p.push(f.agencies.join('/')); if (f.monthsTo !== undefined) p.push(`releasing in months ${f.monthsFrom ?? 0}–${Math.round(f.monthsTo * 10) / 10}`);
  if (f.classifications) p.push(f.classifications.map((c) => c.replace(/_/g, ' ')).join('/')); if (f.priorities) p.push(f.priorities.join('/') + ' priority'); if (f.minValue) p.push(`≥ ${fmtUsd(f.minValue)}`); if (f.maxValue) p.push(`≤ ${fmtUsd(f.maxValue)}`);
  if (f.keywords) p.push(`keywords ${f.keywords.join(', ')}`); if (f.text) p.push(`text “${f.text}”`); if (f.naics) p.push(`NAICS ${f.naics.join(', ')}`); if (f.setAside) p.push(`set-aside ${f.setAside}`);
  return p.length ? p.join(', ') : 'all active opportunities';
}
const HELP = `Examples you can ask:
 • Which DHS opportunities release in the next 6 months?
 • Show high priority recompetes at the Army
 • What changed since yesterday?
 • How many cloud migration opportunities are over $10 million?
 • Top 10 largest opportunities releasing in months 12-24
 • Which contracts are expiring with no follow-on?
 • Did all sources run OK last time?
Answers come from your stored data. If the profile enables an AI model, it can help interpret unusual phrasing, but it never supplies facts.`;

export async function ask(db: Db, question: string, profile: Profile, o: { today?: string; useModel?: boolean } = {}): Promise<Answer> {
  const today = o.today ?? new Date().toISOString().slice(0, 10); const caveats: string[] = [];
  const kwTerms = profile.keywords.map((k) => k.term);
  let f = parseQuestion(question, kwTerms); let usedModel = false;
  const provider = o.useModel === false ? null : await getProvider(db, profile).catch(() => null);
  if (provider && empty(f) && f.intent === 'list') { const x = await translateToFilter(db, provider, question, FILTER_HELP); if (x) { const g = sanitizeFilter(x); if (!empty(g)) { f = g; usedModel = true; caveats.push('An AI model translated this question into the filter shown below; the results themselves come from your database.'); } } }
  const last = db.get(`select * from run where dry_run=0 order by id desc limit 1`);
  if (!last && f.intent !== 'help') return { text: 'No run has completed yet, so there is nothing to search. Try "govcon demo" for sample data, or "govcon run" once your profile and SAM.gov key are set.', rows: [], filter: f, usedModel, caveats, total: 0 };
  if (last && last.status !== 'complete') caveats.push(`The latest run (${String(last.started_at).slice(0, 16)}Z) was ${String(last.status).toUpperCase()}: ${parseJ<any[]>(last.coverage, []).filter((c) => c.status !== 'ok' && c.status !== 'skipped').map((c) => `${c.source} ${c.status}`).join('; ')}. Items may be missing because a source was unavailable.`);
  if (last?.demo) caveats.push('This is SYNTHETIC demo data.');
  if (f.intent === 'help') return { text: HELP, rows: [], filter: f, usedModel, caveats, total: 0 };
  if (f.intent === 'reports') { const rs = db.all(`select id, started_at, status, report_file from run where report_file is not null order by id desc limit 5`); return { text: rs.length ? 'Recent Excel reports:\n' + rs.map((r) => ` • run ${r.id} (${r.status}, ${String(r.started_at).slice(0, 10)}): ${r.report_file}`).join('\n') + '\nGenerate a fresh one with "govcon run" (or "govcon report" to rebuild from stored data).' : 'No report exists yet. Run "govcon demo" or "govcon run".', rows: [], filter: f, usedModel, caveats, total: 0 }; }
  if (f.intent === 'health') { const cov = parseJ<any[]>(last!.coverage, []); return { text: `Run ${last!.id} finished ${String(last!.finished_at ?? '').slice(0, 16)}Z — ${String(last!.status).toUpperCase()}.\n` + cov.map((c) => ` • ${c.source}: ${c.status} — ${String(c.detail).slice(0, 200)}`).join('\n'), rows: [], filter: f, usedModel, caveats, total: 0 }; }
  if (f.intent === 'changes') {
    const since = new Date(Date.now() - (f.changesDays ?? 1) * 864e5).toISOString(); const prevRun = db.get(`select id from run where dry_run=0 and id < ? order by id desc limit 1`, [last!.id]);
    const cs = db.all(`select c.kind, c.field, c.old_value, c.new_value, c.evidence, o.title, o.agency, o.primary_url from change c join opp o on o.id=c.opp_id where (c.detected_at > ? or c.run_id=?) and (c.kind <> 'changed' or c.material=1) and o.review_state not in ('review','dismissed') order by c.id desc limit 40`, [since, last!.id]);
    void prevRun;
    if (!cs.length) return { text: `No new or materially changed opportunities in the last ${(f.changesDays ?? 1) === 1 ? '24 hours' : f.changesDays + ' days'}.`, rows: [], filter: f, usedModel, caveats, total: 0 };
    return { text: `${cs.length} change(s):\n` + cs.map((c) => ` • ${String(c.kind).replace(/_/g, ' ').toUpperCase()}: ${c.title} (${c.agency})${c.field ? ` — ${c.field}: ${c.old_value ?? '—'} → ${c.new_value ?? '—'}` : ''}`).join('\n'), rows: [], filter: f, usedModel, caveats, total: cs.length };
  }
  const { rows, total } = selectRows(db, f.intent === 'expiring' ? { ...f, classifications: ['expiring_no_followon'] } : f, today);
  if (f.intent === 'count') return { text: `${total} active opportunit${total === 1 ? 'y' : 'ies'} match: ${describe(f)}.`, rows: [], filter: f, usedModel, caveats, total };
  if (!rows.length) return { text: `No active opportunities match: ${describe(f)}.${empty(f) ? '' : ' Try a broader question, or check source health with “did all sources run OK?”.'}`, rows, filter: f, usedModel, caveats, total };
  if (rows.some((r) => r.releaseBasis.includes('estimate') || r.releaseBasis === 'unknown')) caveats.push('Release dates marked “agency estimate”, “DERIVED estimate” or “unknown” are not confirmed by a posted notice.');
  if (rows.some((r) => r.linkType === 'listing')) caveats.push('Rows whose link type is “listing” point to the source\'s listing page; search it for the title.');
  let text = `${total} match${total === 1 ? '' : 'es'} for: ${describe(f)}${total > rows.length ? ` (showing ${rows.length})` : ''}\n` + rows.map((r, i) => `${String(i + 1).padStart(2)}. [${r.priority} ${r.score ?? '–'}] ${r.title}\n     ${r.department} — ${r.agency} • release ${r.release ?? 'unknown'} (${r.releaseBasis}) • value ${fmtUsd(r.value)} • ${r.classification.replace(/_/g, ' ')}${r.incumbent ? ' • incumbent ' + r.incumbent : ''}${r.url ? '\n     ' + r.url + (r.linkType === 'listing' ? ' (listing page)' : '') : ''}`).join('\n');
  if (provider && o.useModel !== false && rows.length) {
    const head = `${total} matches for: ${describe(f)}. Top: ` + rows.slice(0, 5).map((r) => `${r.title} (${r.agency}, ${r.priority}, release ${r.release ?? 'unknown'}, ${fmtUsd(r.value)})`).join('; ');
    const rp = await rephrase(db, provider, head); if (rp.used) { text = `${rp.text}\n\n${text}`; usedModel = true; }
  }
  return { text: text + (caveats.length ? '\n\nNotes:\n' + caveats.map((c) => ` - ${c}`).join('\n') : ''), rows, filter: f, usedModel, caveats, total };
}
