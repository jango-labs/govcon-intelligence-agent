// govcon CLI. Run `govcon help`.
import { existsSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadProfile, paths, ProfileError, ROOT } from './config.ts';
import { openDb } from './db.ts';
import { runPipeline } from './pipeline/run.ts';
import { redactText } from './util/log.ts';

const HELP = `govcon — GovCon Opportunity Intelligence Agent

Usage: govcon <command> [options]
  setup                 Guided setup (checks prerequisites, creates config, stores keys, validates, optional demo/live test)
  doctor                Check prerequisites, configuration and connectivity (no secrets printed)
  demo [--two-days]     Run the pipeline on SYNTHETIC data (no network, no credentials) and write a sample Excel report
  run [--dry-run]       Run discovery now with your profile and write the Excel report
  report                Rebuild today's Excel workbook from stored data
  ask "<question>"      Ask a natural-language question about stored opportunities (works without AI)
  serve                 Start the local web UI (http://127.0.0.1:8787 by default)
  daemon                Stay running and execute the daily run on the profile schedule (foreground)
  schedule <print|install|uninstall>   Generate or install an OS scheduler entry (launchd / systemd / cron / Task Scheduler)
  config                Show the effective configuration (secrets masked)
  keywords [list|add <term>|test "<text>"]   Inspect or test the keyword dictionary
  status                Show last runs and source health
  version
Options: --profile <file>  --demo (use the demo database)  --json`;

const args = process.argv.slice(2); const cmd = args[0] ?? 'help'; const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
if (opt('profile')) process.env.GOVCON_PROFILE = opt('profile');

async function main() {
  switch (cmd) {
    case 'help': case '--help': case '-h': console.log(HELP); return;
    case 'version': console.log(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version); return;
    case 'setup': { const { setup } = await import('./setup.ts'); await setup({ yes: flag('yes'), nonInteractive: flag('non-interactive') }); return; }
    case 'doctor': { const { doctor } = await import('./doctor.ts'); const ok = await doctor({ live: flag('live') }); process.exitCode = ok ? 0 : 1; return; }
    case 'demo': { const { demo } = await import('./demo.ts'); await demo({ twoDays: flag('two-days') || flag('all') }); return; }
    case 'run': {
      const s = await runPipeline({ trigger: flag('scheduled') ? 'schedule' : 'manual', dryRun: flag('dry-run') });
      console.log(`Run ${s.runId}: ${s.status.toUpperCase()}${s.dryRun ? ' (dry run — nothing saved)' : ''}\n${s.coverage.map((c) => ` • ${c.source}: ${c.status} — ${c.detail}`).join('\n')}\nReport: ${s.file}`);
      process.exitCode = s.status === 'failed' ? 2 : 0; return;
    }
    case 'report': { const { regenerateReport } = await import('./pipeline/regenerate.ts'); const f = await regenerateReport(); console.log(`Report written: ${f}`); return; }
    case 'ask': { const { ask } = await import('./ask/ask.ts'); const q = args.slice(1).filter((a) => !a.startsWith('--')).join(' '); if (!q) { console.error('Usage: govcon ask "which DHS opportunities release in the next 6 months?"'); process.exitCode = 1; return; }
      const a = await ask(openDb(flag('demo') ? join(paths.dataDir, 'demo', 'demo.sqlite') : undefined), q, loadProfile()); console.log(flag('json') ? JSON.stringify(a, null, 2) : a.text); return; }
    case 'serve': { const { startServer } = await import('./server/app.ts'); await startServer({ demo: flag('demo') }); return; }
    case 'daemon': { const { daemon } = await import('./daemon.ts'); await daemon(); return; }
    case 'schedule': { const { schedule } = await import('./schedule.ts'); await schedule(args[1] ?? 'print'); return; }
    case 'config': { const { showConfig } = await import('./doctor.ts'); await showConfig(); return; }
    case 'keywords': { const { keywordsCmd } = await import('./doctor.ts'); await keywordsCmd(args.slice(1)); return; }
    case 'status': { const { statusCmd } = await import('./doctor.ts'); statusCmd(flag('demo')); return; }
    default: console.error(`Unknown command "${cmd}".\n\n${HELP}`); process.exitCode = 1;
  }
}
main().catch((e) => {
  if (e instanceof ProfileError) console.error(`Configuration problem: ${redactText(e.message)}`);
  else console.error(`Error: ${redactText((e as Error).message ?? String(e))}`);
  if (process.env.GOVCON_LOG_LEVEL === 'debug') console.error((e as Error).stack);
  process.exitCode = 1;
});
void existsSync; void copyFileSync; void mkdirSync; void dirname;
