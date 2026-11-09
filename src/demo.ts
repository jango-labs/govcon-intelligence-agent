// `govcon demo`: runs the full pipeline on SYNTHETIC data into a separate demo database and demo report folder.
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import { loadExampleProfile, paths, loadProfile } from './config.ts';
import { openDb } from './db.ts';
import { runPipeline } from './pipeline/run.ts';

export const demoPaths = () => ({ dir: join(paths.dataDir, 'demo'), db: join(paths.dataDir, 'demo', 'demo.sqlite'), reports: join(paths.dataDir, 'demo', 'reports') });
export async function demo(o: { twoDays?: boolean; quiet?: boolean; now?: Date } = {}) {
  const p = demoPaths(); const profile = (() => { try { return loadProfile(); } catch { return loadExampleProfile(); } })();
  for (const f of [p.db, p.db + '-wal', p.db + '-shm']) if (existsSync(f)) rmSync(f);
  const db = openDb(p.db); const out: Awaited<ReturnType<typeof runPipeline>>[] = [];
  const now = o.now ?? new Date(); const anchor = now.toISOString().slice(0, 10);
  out.push(await runPipeline({ demo: true, db, profile, reportDir: p.reports, now, trigger: 'demo', sampleStep: 1, sampleAnchor: anchor }));
  if (o.twoDays) out.push(await runPipeline({ demo: true, db, profile, reportDir: p.reports, now: new Date(now.getTime() + 864e5), trigger: 'demo', sampleStep: 2, sampleAnchor: anchor }));
  db.close();
  if (!o.quiet) {
    const last = out[out.length - 1];
    console.log(`Demo complete on SYNTHETIC data (no network, no credentials).\n  Opportunities in report: ${last.counts.report_rows}  |  new: ${last.counts.new}  |  changed fields: ${last.counts.changed_fields}\n  Excel report: ${last.file}\n  Demo database: ${p.db}\n  Browse it: npm run serve -- --demo   then open http://127.0.0.1:8787`);
  }
  return out;
}
