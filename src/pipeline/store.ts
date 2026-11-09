// Canonical store: deterministic identity resolution, field-level merge with provenance and conflicts, and change events.
// One real-world procurement seen by several sources becomes ONE row; disagreements between sources are kept as conflicts, never silently overwritten.
import { Db, J, parseJ, type Row } from '../db.ts';
import type { Candidate } from '../types.ts';
import { normSol } from '../connectors/shared.ts';

const RANK: Record<string, number> = { sam_notice: 1, sample: 1, gsa_forecast: 2, csv_import: 3, usaspending_award: 4 };
export const rankOf = (c: { source: string }): number => RANK[c.source] ?? 3;
const BASIS_RANK: Record<string, number> = { government: 1, government_estimate: 2, imported: 3, estimate: 4, unknown: 9 };
const ORDER = ['unknown', 'new_requirement', 'expiring_no_followon', 'possible_followon', 'likely_recompete', 'confirmed_recompete'];

export const OPP_JSON = ['incumbent', 'indicators', 'matched_keywords', 'relevance_detail', 'priority_detail', 'gaps', 'sources', 'fields'] as const;
export function parseOpp(r: Row): any {
  const o: any = { ...r };
  const dflt: Record<string, any> = { incumbent: {}, indicators: [], matched_keywords: [], relevance_detail: {}, priority_detail: {}, gaps: [], sources: [], fields: {} };
  for (const k of OPP_JSON) o[k] = parseJ(r[k], dflt[k]);
  return o;
}
export function resolve(db: Db, c: Candidate): { id: number; via: string } | null {
  let r = db.get(`select opp_id from source_record where source=? and source_id=?`, [c.source, c.sourceId]);
  if (r) return { id: r.opp_id, via: 'source id' };
  if (c.source === 'sam_notice' && /^[0-9a-f]{32}$/i.test(c.sourceId)) { r = db.get(`select id opp_id from opp where primary_url like ? order by id limit 1`, [`%/opp/${c.sourceId}/%`]); if (r) return { id: r.opp_id, via: 'SAM notice ID' }; }
  const s = normSol(c.solicitationNumber);
  if (s) { r = db.get(`select id opp_id from opp where upper(replace(replace(replace(replace(coalesce(solicitation_number,''),'-',''),' ',''),'/',''),'.',''))=? order by id limit 1`, [s]); if (r) return { id: r.opp_id, via: 'solicitation number' }; }
  if (c.piid) { r = db.get(`select id opp_id from opp where piid=? order by id limit 1`, [c.piid]); if (r) return { id: r.opp_id, via: 'PIID' }; }
  return null;
}
const canonKey = (c: Candidate) => normSol(c.solicitationNumber) ? `sol:${normSol(c.solicitationNumber)}` : c.piid ? `piid:${c.piid}` : `${c.source}:${c.sourceId}`;

export const TRACKED = ['title', 'department', 'agency', 'subagency', 'sol_date', 'award_date', 'value_usd', 'set_aside', 'instrument', 'vehicle', 'duration', 'naics', 'status', 'classification'] as const;
export interface Change { field: string; old: string | null; new: string | null; material: boolean }

function recordSource(db: Db, oppId: number, c: Candidate) {
  db.run(`insert into source_record(opp_id, source, source_id, url, update_date, payload) values (?,?,?,?,?,?)
    on conflict(source, source_id) do update set opp_id=excluded.opp_id, url=excluded.url, update_date=excluded.update_date, payload=excluded.payload, fetched_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    [oppId, c.source, c.sourceId, c.url ?? null, c.updated ?? null, JSON.stringify(c.raw ?? {}).slice(0, 100_000)]);
}
const dedupeConflicts = (cs: any[]) => { const seen = new Set<string>(); return cs.filter((c) => { const k = JSON.stringify([c.field, c.a, c.b]); if (seen.has(k)) return false; seen.add(k); return true; }).slice(-20); };

export function upsert(db: Db, c: Candidate, runId: number, th: { dateDays: number; valuePct: number }): { id: number; created: boolean; via: string; changes: Change[] } {
  const hit = resolve(db, c); const now = new Date().toISOString();
  if (!hit) {
    const r = db.run(`insert into opp(canon_key, solicitation_number, piid, title, department, agency, subagency, description, sol_date, sol_date_basis, award_date, award_date_basis, value_usd, value_type, value_note, set_aside, instrument, vehicle, duration, naics, psc, status, classification, incumbent, sources, primary_url, url_kind, source_updated, last_seen_run, last_seen_at, fields)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(canon_key) do update set last_seen_run=excluded.last_seen_run returning id`.replace(' returning id', ''),
      [canonKey(c), c.solicitationNumber ?? null, c.piid ?? null, c.title, c.department, c.agency, c.subagency, c.description ?? null, c.solDate ?? null, c.solBasis ?? 'unknown', c.awardDate ?? null, c.awardBasis ?? 'unknown', c.valueUsd ?? null, c.valueType ?? null, c.valueNote ?? null,
        c.setAside ?? null, c.instrument ?? null, c.vehicle ?? null, c.duration ?? null, c.naics ?? null, c.psc ?? null, c.status ?? null, c.classHint ?? 'unknown', J(c.incumbent ?? {}), J([c.source]), c.url ?? null, c.urlKind ?? (c.url ? 'record' : 'none'), c.updated ?? null, runId, now,
        J({ fiscalYear: c.fiscalYear ?? null, stage: c.stage ?? null, classEvidence: c.classEvidence ?? null, other: c.other ?? null, prov: { primary: c.source, rank: rankOf(c) }, conflicts: [] })]);
    const id = Number(db.get(`select id from opp where canon_key=?`, [canonKey(c)])!.id); void r;
    recordSource(db, id, c);
    return { id, created: true, via: 'new', changes: [{ field: 'record', old: null, new: 'new opportunity', material: true }] };
  }
  const cur = db.get(`select * from opp where id=?`, [hit.id])!; const f = parseJ<any>(cur.fields, {}); const conflicts: any[] = f.conflicts ?? []; const rank = rankOf(c);
  const curRank = f.prov?.rank ?? RANK[f.prov?.primary ?? 'usaspending_award'] ?? 9; const cInc = parseJ<any>(cur.incumbent, {});
  const sets: Record<string, unknown> = {};
  const conflict = (field: string, av: string, bv: string, extra?: object) => conflicts.push({ field, a: { source: f.prov?.primary, value: av, ...(extra && 'a' in extra ? (extra as any).a : {}) }, b: { source: c.source, value: bv, ...(extra && 'b' in extra ? (extra as any).b : {}) } });
  const pick = (col: string, val: unknown) => {
    if (val == null || val === '') return;
    if (cur[col] == null || cur[col] === '' || rank <= curRank) { if (cur[col] != null && cur[col] !== '' && String(cur[col]) !== String(val)) conflict(col, String(cur[col]), String(val)); if (String(cur[col] ?? '') !== String(val)) sets[col] = val; }
    else if (String(cur[col]) !== String(val) && col !== 'description') conflict(col, String(cur[col]), String(val));
  };
  const dateField = (col: 'sol_date' | 'award_date', val?: string | null, basis?: string) => {
    if (!val) return; const bcol = col + '_basis'; const cb = BASIS_RANK[cur[bcol] ?? 'unknown'] ?? 9, nb = BASIS_RANK[basis ?? 'unknown'] ?? 9; const curStr = cur[col] ?? null;
    if (!curStr || nb < cb || (nb === cb && rank <= curRank)) { if (curStr && curStr !== val) conflict(col, curStr, val, { a: { basis: cur[bcol] }, b: { basis } }); if (curStr !== val) sets[col] = val; sets[bcol] = basis ?? 'unknown'; }
    else if (curStr !== val) conflict(col, curStr, val, { a: { basis: cur[bcol] }, b: { basis } });
  };
  dateField('sol_date', c.solDate, c.solBasis); dateField('award_date', c.awardDate, c.awardBasis);
  pick('title', c.title); pick('department', c.department); pick('agency', c.agency); pick('subagency', c.subagency);
  pick('description', c.description && c.description.length > (cur.description?.length ?? 0) ? c.description : null);
  pick('set_aside', c.setAside); pick('instrument', c.instrument); pick('vehicle', c.vehicle); pick('duration', c.duration); pick('naics', c.naics); pick('psc', c.psc); pick('status', c.status);
  if (c.valueUsd != null && (cur.value_usd == null || rank <= curRank)) { if (cur.value_usd != null && Number(cur.value_usd) !== c.valueUsd) conflict('value_usd', String(cur.value_usd), String(c.valueUsd)); sets.value_usd = c.valueUsd; sets.value_type = c.valueType ?? cur.value_type; sets.value_note = c.valueNote ?? cur.value_note; }
  if (c.solicitationNumber && !cur.solicitation_number) sets.solicitation_number = c.solicitationNumber;
  if (c.piid && !cur.piid) sets.piid = c.piid;
  if (c.url && (!cur.primary_url || rank <= curRank)) { sets.primary_url = c.url; sets.url_kind = c.urlKind ?? 'record'; }
  if (c.updated && (!cur.source_updated || new Date(c.updated) > new Date(cur.source_updated))) sets.source_updated = c.updated;
  if (c.incumbent?.name) {
    if (!cInc.name || rank <= curRank) { if (cInc.piid && c.incumbent.piid && cInc.piid !== c.incumbent.piid) conflict('incumbent', `${cInc.name} ${cInc.piid}`, `${c.incumbent.name} ${c.incumbent.piid}`); sets.incumbent = J({ ...cInc, ...c.incumbent }); }
    else sets.incumbent = J({ ...c.incumbent, ...cInc });
  }
  if (c.classHint && ORDER.indexOf(c.classHint) > ORDER.indexOf(cur.classification)) { sets.classification = c.classHint; f.classEvidence = c.classEvidence ?? f.classEvidence; }
  if (c.fiscalYear) f.fiscalYear = c.fiscalYear;
  if (c.stage) f[`stage_${c.source}`] = c.stage;
  if (c.other && !f.other) f.other = c.other;
  f.conflicts = dedupeConflicts(conflicts);
  if (rank < curRank || f.prov?.rank == null) f.prov = { ...(f.prov ?? {}), primary: rank < curRank ? c.source : (f.prov?.primary ?? c.source), rank: Math.min(rank, curRank) };
  const sources = [...new Set([...parseJ<string[]>(cur.sources, []), c.source])];
  const changes: Change[] = [];
  for (const col of TRACKED) {
    if (!(col in sets)) continue;
    const o = cur[col] == null ? null : String(cur[col]); const n = sets[col] == null ? null : String(sets[col]);
    if (o === n || (o == null && n == null)) continue;
    if (o == null) continue;                    // first fill-in of a previously empty field is enrichment, not a change
    let material = true;
    if (col.endsWith('_date') && o && n) material = Math.abs(new Date(n).getTime() - new Date(o).getTime()) / 864e5 >= th.dateDays;
    if (col === 'value_usd' && o && n) { const a = Number(o), b = Number(n); material = a > 0 ? Math.abs(b - a) / a * 100 >= th.valuePct : true; }
    if (col === 'duration') material = false;
    changes.push({ field: col, old: o, new: n, material });
  }
  sets.sources = J(sources); sets.fields = J(f); sets.last_seen_run = runId; sets.updated_at = now; sets.last_seen_at = now;
  const cols = Object.keys(sets);
  db.run(`update opp set ${cols.map((k) => `${k}=?`).join(', ')} where id=?`, [...cols.map((k) => sets[k] as any), hit.id]);
  recordSource(db, hit.id, c);
  return { id: hit.id, created: false, via: hit.via, changes };
}
export { ORDER as CLASS_ORDER };
