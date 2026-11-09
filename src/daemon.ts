// Foreground scheduler: executes the daily run at the profile's cron time in the profile's time zone. Works the same on Windows, macOS and Linux
// and in Docker. Missed runs (computer asleep) are caught up when the process wakes, within a 36-hour window.
import { loadProfile, paths } from './config.ts';
import { openDb } from './db.ts';
import { isDueTz, nextRuns } from './cron.ts';
import { runPipeline } from './pipeline/run.ts';
import { logger, redactText } from './util/log.ts';

export async function daemon(o: { tickMs?: number; once?: boolean; now?: () => Date } = {}) {
  const profile = loadProfile(); const now = o.now ?? (() => new Date()); let stop = false;
  process.on('SIGINT', () => { stop = true; }); process.on('SIGTERM', () => { stop = true; });
  const next = nextRuns(profile.schedule, profile.timezone, now(), 1)[0];
  logger.info('daemon started', { schedule: profile.schedule, timezone: profile.timezone, nextRun: next?.toISOString(), db: paths.dbFile });
  console.log(`Daemon running. Schedule "${profile.schedule}" (${profile.timezone}); next run ${next?.toISOString() ?? 'unknown'}. Press Ctrl+C to stop.`);
  let busy = false;
  const tick = async () => {
    if (busy) return; const db = openDb(); const last = db.getSetting<string | null>('daemon.lastRun', null); db.close();
    if (!isDueTz(profile.schedule, last ? new Date(last) : null, now(), profile.timezone)) return;
    busy = true;
    try {
      const d = openDb(); d.setSetting('daemon.lastRun', now().toISOString()); d.close();     // recorded first so a crash mid-run does not cause a rerun loop
      const s = await runPipeline({ trigger: 'schedule' }); logger.info('scheduled run finished', { runId: s.runId, status: s.status, file: s.file });
    } catch (e) { logger.error('scheduled run failed', { err: redactText((e as Error).message) }); }
    finally { busy = false; }
  };
  await tick();
  if (o.once) return;
  while (!stop) { await new Promise((r) => setTimeout(r, o.tickMs ?? 30_000)); if (stop) break; await tick(); }
  logger.info('daemon stopped');
}
