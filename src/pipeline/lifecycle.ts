// Lifecycle, disappearance logic and forecast snapshots. A source outage never reads as "the opportunity disappeared".
import { createHash } from 'node:crypto';
import { Db, parseJ } from '../db.ts';
import type { SourceCoverage } from '../types.ts';

export function updateLifecycle(db: Db, runId: number, windowTo: string, coverage: SourceCoverage[], sourceNames: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = { awarded: 0, cancelled: 0, out_of_window: 0, returned: 0, no_longer_matched: 0, unverified_absent: 0 };
  const log = (id: number, kind: string, evidence: string, field?: string, o?: string | null, n?: string | null) => db.run(`insert into change(run_id, opp_id, kind, field, old_value, new_value, evidence) values (?,?,?,?,?,?,?)`, [runId, id, kind, field ?? 'lifecycle', o ?? null, n ?? kind, evidence]);
  for (const r of db.all(`select id, status, lifecycle, sol_date, award_date from opp where lifecycle in ('active','awarded','cancelled','out_of_window')`)) {
    let next = 'active'; const st = String(r.status ?? '');
    if (/cancel|no longer required/i.test(st)) next = 'cancelled'; else if (/\bawarded\b|\bwon\b/i.test(st)) next = 'awarded';
    else { const ds = [r.sol_date, r.award_date].filter(Boolean) as string[]; if (ds.length && ds.every((d) => d > windowTo)) next = 'out_of_window'; }
    if (next !== r.lifecycle) {
      db.run(`update opp set lifecycle=?, updated_at=? where id=?`, [next, new Date().toISOString(), r.id]);
      const kind = next === 'active' ? 'returned' : next; out[kind] = (out[kind] ?? 0) + 1;
      log(r.id, kind, next === 'out_of_window' ? 'all known milestone dates now fall after the reporting window (not a cancellation)' : `source status is "${st}"`, 'lifecycle', r.lifecycle, next);
    }
  }
  // Records seen only by one source and absent from that source's COMPLETE listing → "no longer matches"; absent from a partial one → unverified, status unchanged.
  for (const [src, name] of Object.entries(sourceNames)) {
    const cov = coverage.find((c) => c.source === name); if (!cov || cov.status === 'skipped') continue;
    const absent = db.all(`select id from opp where lifecycle='active' and sources = ? and (last_seen_run is null or last_seen_run <> ?)`, [JSON.stringify([src]), runId]);
    for (const r of absent) {
      if (cov.status === 'ok') { db.run(`update opp set lifecycle='no_longer_matched', updated_at=? where id=?`, [new Date().toISOString(), r.id]); log(r.id, 'no_longer_matched', `not returned by ${name} although that source listing completed; this is not evidence of cancellation`); out.no_longer_matched++; }
      else out.unverified_absent++;
    }
  }
  return out;
}
export function snapshots(db: Db, runId: number): number {
  let n = 0;
  for (const r of db.all(`select id, sol_date, sol_date_basis, award_date, award_date_basis, value_usd, set_aside, vehicle, instrument, status, classification, fields from opp where lifecycle in ('active','awarded','out_of_window')`)) {
    const f = { sol_date: r.sol_date, sol_basis: r.sol_date_basis, award_date: r.award_date, award_basis: r.award_date_basis, value_usd: r.value_usd, set_aside: r.set_aside, vehicle: r.vehicle, instrument: r.instrument, status: r.status, classification: r.classification, fiscal_year: parseJ<any>(r.fields, {}).fiscalYear ?? null };
    const h = createHash('sha1').update(JSON.stringify(f)).digest('hex'); const last = db.get(`select fields from snapshot where opp_id=? order by id desc limit 1`, [r.id]);
    if (last && createHash('sha1').update(JSON.stringify(JSON.parse(last.fields))).digest('hex') === h) continue;
    db.run(`insert into snapshot(opp_id, run_id, fields) values (?,?,?) on conflict(opp_id, run_id) do nothing`, [r.id, runId, JSON.stringify(f)]); n++;
  }
  return n;
}
