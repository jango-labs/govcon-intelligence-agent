// `govcon doctor`: prerequisites, configuration and (optionally) live connectivity. Never prints secret values.
import { existsSync, accessSync, constants, readFileSync } from 'node:fs';
import { loadProfile, paths, ProfileError, ROOT } from './config.ts';
import { openDb, parseJ } from './db.ts';
import { getSecret, mask, secretStore, keyringSupported } from './secrets.ts';
import { testSam } from './connectors/sam.ts';
import { toKeywords, compile, matchKeywords } from './keywords.ts';
import { simpleDaily } from './schedule.ts';
import { USER_AGENT } from './util/http.ts';

export interface Check { ok: boolean | 'warn'; label: string; detail?: string }
const icon = (c: Check) => (c.ok === true ? '✓' : c.ok === 'warn' ? '!' : '✗');
export async function collectChecks(o: { live?: boolean } = {}): Promise<Check[]> {
  const out: Check[] = []; const add = (ok: boolean | 'warn', label: string, detail?: string) => out.push({ ok, label, detail });
  const major = Number(process.versions.node.split('.')[0]); add(major >= 24, `Node.js ${process.versions.node}`, major >= 24 ? undefined : 'Node.js 24 or newer is required (https://nodejs.org)');
  try { const { DatabaseSync } = await import('node:sqlite'); new DatabaseSync(':memory:').close(); add(true, 'Built-in SQLite available'); } catch (e) { add(false, 'Built-in SQLite (node:sqlite)', (e as Error).message); }
  try { await import('exceljs'); add(true, 'Excel library (exceljs) installed'); } catch { add(false, 'Excel library missing', 'run "npm install" in the project folder'); }
  try { accessSync(paths.dataDir, constants.W_OK); add(true, `Data folder writable (${paths.dataDir})`); } catch { add(false, `Data folder not writable (${paths.dataDir})`); }
  let profile: ReturnType<typeof loadProfile> | null = null;
  try { profile = loadProfile(); add(true, `Profile valid (${paths.profileFile}) — ${profile.keywords.length} keywords, departments ${profile.scope.departments.join('/')}`); } catch (e) { add(false, 'Profile', (e as ProfileError).message); }
  if (existsSync(paths.dbFile)) { try { const db = openDb(); const n = db.get('select count(*) n from run')!.n; db.close(); add(true, `Database OK (${n} run${n === 1 ? '' : 's'} stored)`); } catch (e) { add(false, 'Database', (e as Error).message); } } else add('warn', 'Database not created yet', 'it is created on the first run or demo');
  const sam = await getSecret('SAM_API_KEY'); add(sam ? true : 'warn', `SAM.gov API key: ${mask(sam)}`, sam ? undefined : 'optional — without it only USAspending, GSA forecast and GAO run. Get a free key: README → "Get a SAM.gov API key"');
  add(true, `Secret store: ${secretStore()}${process.env.GOVCON_SECRET_STORE === 'keyring' && !keyringSupported() ? ' (keyring unsupported here; using env)' : ''}`);
  const host = process.env.GOVCON_HOST ?? '127.0.0.1'; const tok = await getSecret('GOVCON_UI_TOKEN'); const loop = /^(127\.|localhost|::1|\[::1\])/.test(host);
  add(loop || !!tok, `Web UI binds to ${host}:${process.env.GOVCON_PORT ?? 8787}${loop ? ' (this computer only)' : tok ? ' with an access token' : ''}`, loop || tok ? undefined : 'non-loopback host without GOVCON_UI_TOKEN — the UI will refuse to start');
  if (profile) {
    add(profile.llm.provider === 'none' ? true : 'warn', `AI layer: ${profile.llm.provider}${profile.llm.provider === 'none' ? ' (off; everything works without it)' : ` model "${profile.llm.model || 'default'}" — questions/results may be sent to that provider`}`);
    const t = simpleDaily(profile.schedule); add(true, `Schedule: "${profile.schedule}" ${profile.timezone}${t ? '' : ' (not a simple daily time: use "govcon daemon")'}`);
    if (!profile.sources.sam.enabled && !profile.sources.usaspending.enabled && !profile.sources.gsaForecast.enabled) add('warn', 'All built-in sources are disabled in the profile');
  }
  if (o.live) {
    const probe = async (label: string, url: string) => { try { const r = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(20000) }); add(r.ok, `${label} reachable (HTTP ${r.status})`); } catch (e) { add(false, `${label} not reachable`, (e as Error).message); } };
    await probe('USAspending API', 'https://api.usaspending.gov/api/v2/references/toptier_agencies/');
    await probe('GSA Acquisition Gateway forecast', 'https://ag-dashboard.acquisitiongateway.gov/api/v3.0/resources/forecast?range=1&page=0');
    await probe('GAO reports feed', 'https://www.gao.gov/rss/reports.xml');
    if (sam) { const r = await testSam(sam); add(r.ok, `SAM.gov key test: ${r.detail}`); }
  } else add('warn', 'Live connectivity not tested', 'run "govcon doctor --live" to test the public sources and your SAM.gov key');
  return out;
}
export async function doctor(o: { live?: boolean } = {}): Promise<boolean> {
  const checks = await collectChecks(o); for (const c of checks) console.log(` ${icon(c)} ${c.label}${c.detail ? `\n     ${c.detail}` : ''}`);
  const bad = checks.filter((c) => c.ok === false).length; console.log(bad ? `\n${bad} problem(s) found.` : '\nAll required checks passed.'); return bad === 0;
}
export async function showConfig() {
  const p = loadProfile(); console.log(JSON.stringify({ profileFile: paths.profileFile, dataDir: paths.dataDir, database: paths.dbFile, reportDir: paths.reportDir, secretStore: secretStore(),
    secrets: { SAM_API_KEY: mask(await getSecret('SAM_API_KEY')), GOVCON_UI_TOKEN: mask(await getSecret('GOVCON_UI_TOKEN')), ANTHROPIC_API_KEY: mask(await getSecret('ANTHROPIC_API_KEY')), OPENAI_API_KEY: mask(await getSecret('OPENAI_API_KEY')) }, profile: { ...p, keywords: `${p.keywords.length} keywords (govcon keywords list)` } }, null, 2));
}
export async function keywordsCmd(a: string[]) {
  const p = loadProfile(); const sub = a[0] ?? 'list';
  if (sub === 'list') { const by = new Map<string, string[]>(); for (const k of p.keywords) by.set(k.category ?? 'General', [...(by.get(k.category ?? 'General') ?? []), k.term]); for (const [c, t] of by) console.log(`${c}: ${t.join(', ')}`); return; }
  if (sub === 'test') { const text = a.slice(1).join(' '); const m = matchKeywords({ title: text }, compile(toKeywords(p.keywords)), p.relevance.threshold); console.log(`${m.tier.toUpperCase()} score ${m.score}: ${m.rationale}`); return; }
  console.log('Edit config/profile.json to add or change keywords (see CONFIGURATION.md). Test with: govcon keywords test "your title text"');
}
export function statusCmd(demo = false) {
  const db = openDb(demo ? `${paths.dataDir}/demo/demo.sqlite` : undefined); const runs = db.all(`select id, started_at, status, counts, coverage, report_file from run where dry_run=0 order by id desc limit 5`);
  if (!runs.length) console.log('No runs yet. Try "govcon demo" or "govcon run".');
  for (const r of runs) { const c = parseJ<Record<string, number>>(r.counts, {}); console.log(`Run ${r.id} ${String(r.started_at).slice(0, 16)}Z ${String(r.status).toUpperCase()} — new ${c.new ?? 0}, changed ${c.changed_fields ?? 0}, report rows ${c.report_rows ?? 0}\n   ${r.report_file ?? ''}`); if (r === runs[0]) for (const s of parseJ<any[]>(r.coverage, [])) console.log(`   • ${s.source}: ${s.status} — ${String(s.detail).slice(0, 140)}`); }
  db.close(); void readFileSync; void ROOT;
}
