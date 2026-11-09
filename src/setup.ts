// `govcon setup`: guided first-run. Secrets are typed with echo OFF, written only to .env (mode 600) or the OS keyring, and never printed or logged.
import { createInterface } from 'node:readline';
import { existsSync, copyFileSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { paths, loadProfile, validateProfile, DEFAULT_PROFILE, ROOT } from './config.ts';
import { setEnvValue, envPath } from './envfile.ts';
import { setSecret, secretStore, keyringSupported, type SecretName } from './secrets.ts';
import { testSam } from './connectors/sam.ts';
import { collectChecks } from './doctor.ts';
import { demo } from './demo.ts';
import { runPipeline } from './pipeline/run.ts';
import { openDb } from './db.ts';
import { simpleDaily } from './schedule.ts';

let rl: ReturnType<typeof createInterface> | null = null;
const lines: string[] = []; let waiting: ((s: string) => void) | null = null; let ended = false;
function initRl() { if (rl) return; rl = createInterface({ input: process.stdin }); rl.on('line', (l) => { if (waiting) { const w = waiting; waiting = null; w(l); } else lines.push(l); }); rl.on('close', () => { ended = true; if (waiting) { const w = waiting; waiting = null; w(''); } }); }
const nextLine = () => new Promise<string>((res) => { if (lines.length) return res(lines.shift()!); if (ended) return res(''); waiting = res; });
async function ask(prompt: string, def = ''): Promise<string> { initRl(); process.stdout.write(`${prompt}${def ? ` [${def}]` : ''}: `); const a = (await nextLine()).trim(); return a || def; }
async function yesNo(prompt: string, def = true): Promise<boolean> { const a = (await ask(`${prompt} (${def ? 'Y/n' : 'y/N'})`)).toLowerCase(); return a ? a.startsWith('y') : def; }
/** Read a secret with terminal echo disabled. When stdin is not a TTY (piped), reads a plain line. */
export async function askHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) { initRl(); process.stdout.write(`${prompt} (input not hidden: not a terminal): `); return (await nextLine()).trim(); }
  rl?.close(); rl = null; process.stdout.write(`${prompt} (typing is hidden): `);
  return new Promise<string>((resolve) => {
    let v = ''; const si = process.stdin; si.setRawMode(true); si.resume(); si.setEncoding('utf8');
    const on = (ch: string) => { for (const c of ch) { if (c === '\r' || c === '\n') { si.setRawMode(false); si.pause(); si.off('data', on); process.stdout.write('\n'); return resolve(v.trim()); } if (c === '\u0003') { si.setRawMode(false); process.stdout.write('\n'); process.exit(130); } if (c === '\u007f' || c === '\b') v = v.slice(0, -1); else v += c; } };
    si.on('data', on);
  });
}
const say = (s = '') => console.log(s);

async function storeSecret(name: SecretName, value: string, useKeyring: boolean) {
  if (useKeyring) { await setSecret(name, value); say(`  Saved ${name} in the OS keyring.`); } else { setEnvValue(name, value); say(`  Saved ${name} in ${envPath()} (owner-only permissions). That file is git-ignored; never share or commit it.`); }
}

export async function setup(o: { yes?: boolean; nonInteractive?: boolean } = {}) {
  const auto = !!(o.yes || o.nonInteractive);
  say('GovCon Intelligence Agent — guided setup\n');
  say('Step 1/7  Checking prerequisites');
  const pre = await collectChecks(); let blocked = false;
  for (const c of pre.slice(0, 4)) { say(`  ${c.ok === true ? '✓' : '✗'} ${c.label}${c.detail ? ' — ' + c.detail : ''}`); if (c.ok === false) blocked = true; }
  if (blocked) { say('\nFix the items above, then run setup again.'); process.exitCode = 1; return; }

  say('\nStep 2/7  Profile (what to look for)');
  const pf = paths.profileFile; mkdirSync(dirname(pf), { recursive: true });
  if (!existsSync(pf)) { copyFileSync(paths.examplesProfile, pf); say(`  Created ${pf} from the example profile.`); } else say(`  Using existing ${pf}.`);
  const prof = JSON.parse(readFileSync(pf, 'utf8'));
  if (!auto) {
    say('  Departments to track: DoD, DHS, DOJ, HHS, VA, DOE, DOT, State, Treasury, USDA, DOI, Commerce, Education, Labor, HUD, EPA, NASA, GSA, SSA ... or ALL.');
    const d = await ask('  Departments (comma-separated)', (prof.scope?.departments ?? DEFAULT_PROFILE.scope.departments).join(',')); prof.scope = { ...(prof.scope ?? {}), departments: d.split(',').map((x) => x.trim()).filter(Boolean) };
    const tz = await ask('  Time zone for the daily run (IANA name)', prof.timezone ?? 'America/New_York'); prof.timezone = tz;
    const time = await ask('  Daily run time, 24-hour HH:MM', (() => { const t = simpleDaily(prof.schedule ?? '0 6 * * *'); return t ? `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}` : '06:00'; })());
    const m = /^(\d{1,2}):(\d{2})$/.exec(time); if (m) prof.schedule = `${Number(m[2])} ${Number(m[1])} * * *`;
    say('  Keywords: edit config/profile.json → "keywords" any time (see CONFIGURATION.md). The starter list covers common IT-modernization topics.');
  }
  const problems = validateProfile({ ...DEFAULT_PROFILE, ...prof, scope: { ...DEFAULT_PROFILE.scope, ...prof.scope }, filters: { ...DEFAULT_PROFILE.filters, ...prof.filters }, priority: { ...DEFAULT_PROFILE.priority, ...prof.priority }, relevance: { ...DEFAULT_PROFILE.relevance, ...prof.relevance }, llm: { ...DEFAULT_PROFILE.llm, ...prof.llm } });
  if (problems.length) { say('  Profile problems:\n   - ' + problems.join('\n   - ')); process.exitCode = 1; return; }
  writeFileSync(pf, JSON.stringify(prof, null, 2) + '\n'); say('  Profile validated and saved.');

  say('\nStep 3/7  Credentials');
  let useKeyring = false;
  if (!auto && keyringSupported()) { useKeyring = await yesNo(`  Store secrets in the OS keyring (${process.platform === 'darwin' ? 'macOS Keychain' : 'libsecret'}) instead of a .env file?`, false); if (useKeyring) setEnvValue('GOVCON_SECRET_STORE', 'keyring'); }
  if (!existsSync(envPath()) && !useKeyring) copyFileSync(`${ROOT}/.env.example`, envPath());
  if (process.env.SAM_API_KEY) say('  SAM_API_KEY is already provided by the environment.');
  else if (!auto) {
    say('  SAM.gov (free) adds live contract notices. Get a key: sign in at https://sam.gov → your profile → "Account Details" → "Public API Key" (see README).');
    if (await yesNo('  Enter a SAM.gov API key now?', true)) {
      for (let tries = 0; tries < 3; tries++) {
        const key = await askHidden('  SAM.gov API key'); if (!key) break;
        const r = await testSam(key); say(`  Test: ${r.detail}`);
        if (r.ok) { await storeSecret('SAM_API_KEY', key, useKeyring); break; }
        if (!(await yesNo('  Try a different key?', true))) { if (await yesNo('  Save this key anyway?', false)) await storeSecret('SAM_API_KEY', key, useKeyring); break; }
      }
    } else say('  Skipped. You can add it later (re-run setup, or put SAM_API_KEY in .env). Public sources still work.');
    say('\n  Optional AI for natural-language questions (default none; nothing is sent anywhere). Providers: none, ollama (local), anthropic, openai.');
    const prov = (await ask('  AI provider', 'none')).toLowerCase(); if (['ollama', 'anthropic', 'openai'].includes(prov)) {
      const p2 = JSON.parse(readFileSync(pf, 'utf8')); p2.llm = { ...(p2.llm ?? {}), provider: prov, model: await ask('  Model name (blank = provider default)', ''), monthlyCapUsd: prov === 'ollama' ? 0 : Number(await ask('  Monthly spending cap in USD (0 blocks paid calls)', '5')) || 0 }; writeFileSync(pf, JSON.stringify(p2, null, 2) + '\n');
      if (prov === 'anthropic' || prov === 'openai') { const nm = prov === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'; const k = await askHidden(`  ${nm}`); if (k) await storeSecret(nm, k, useKeyring); say('  Note: with a cloud provider your question and the few result rows needed to answer it are sent to that provider.'); }
    }
  } else say('  Non-interactive mode: set SAM_API_KEY in the environment or .env yourself.');

  say('\nStep 4/7  Initialising the local database');
  openDb().close(); say(`  ✓ ${paths.dbFile}`);

  say('\nStep 5/7  Sample demo (synthetic data, no network)');
  if (auto || (await yesNo('  Run the demo and create a sample Excel report?', true))) { await demo({ twoDays: true }); }

  say('\nStep 6/7  Live discovery test');
  const prof2 = loadProfile(); const hasKey = !!(process.env.SAM_API_KEY || (secretStore() === 'keyring'));
  if (!auto && (await yesNo(`  Run a live dry-run now (${hasKey ? 'SAM.gov + ' : ''}USAspending + GSA forecast + GAO; nothing is saved)?`, false))) {
    const s = await runPipeline({ dryRun: true, trigger: 'setup-test', profile: prof2 }); say(`  Result: ${s.status.toUpperCase()}`); for (const c of s.coverage) say(`   • ${c.source}: ${c.status} — ${c.detail.slice(0, 160)}`); say(`  Sample report (not saved to the database): ${s.file}`);
  } else say('  Skipped. Later: "govcon run --dry-run" tests without saving, "govcon run" saves.');

  say('\nStep 7/7  Start, stop and schedule');
  say(`  • Browse results:      npm run serve        → http://127.0.0.1:${process.env.GOVCON_PORT ?? 8787}   (Ctrl+C stops it)
  • Run discovery now:   npm run run
  • Ask questions:       npm run govcon -- ask "high priority recompetes"
  • Daily schedule:      keep a terminal/service running:   npm run daemon
                         or install an OS entry:            npm run govcon -- schedule print   (then "install")
  • Health check:        npm run doctor -- --live
  • Stop daemon/server:  Ctrl+C (or stop the service/container); remove OS entry with "schedule uninstall"`);
  say('\nSetup complete.'); rl?.close();
}
