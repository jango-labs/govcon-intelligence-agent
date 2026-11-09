// Rebuild the workbook from stored data (no network). Useful after editing nothing but wanting today's file again.
import { openDb, parseJ } from '../db.ts';
import { loadProfile } from '../config.ts';
import { buildWorkbook } from './report.ts';
import type { SourceCoverage } from '../types.ts';

export async function regenerateReport(db = openDb(), reportDir?: string): Promise<string> {
  const run = db.get(`select * from run where dry_run=0 and status in ('complete','partial') order by id desc limit 1`);
  if (!run) throw new Error('No completed run found. Run "govcon run" (or "govcon demo") first.');
  const prev = db.get(`select id, status from run where dry_run=0 and status in ('complete','partial') and id < ? order by id desc limit 1`, [run.id]);
  const profile = loadProfile();
  const rep = await buildWorkbook(db, { runId: run.id, asOf: new Date(), status: run.status, coverage: parseJ<SourceCoverage[]>(run.coverage, []), windowFrom: run.window_from, windowTo: run.window_to, mode: run.mode,
    baselineRunId: prev?.id ?? null, baselineStatus: prev?.status ?? null, dry: false, demo: !!run.demo, counts: parseJ(run.counts, {}), thresholds: { dateDays: profile.changeThresholds.dateShiftDays, valuePct: profile.changeThresholds.valueChangePct }, audit: parseJ(run.audit, {}), profile }, reportDir);
  return rep.file;
}
