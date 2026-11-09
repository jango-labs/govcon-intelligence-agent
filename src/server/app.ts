// Local web UI + JSON API on node:http (no framework). Binds to 127.0.0.1 by default.
// Safety: Host-header allow-list (DNS-rebinding defence), CSRF header on every POST, strict CSP, optional access token (required when not bound to loopback),
// all dynamic text is rendered with textContent in the browser, downloads are restricted to files inside the reports folder.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ROOT, paths, loadProfile } from '../config.ts';
import { openDb, parseJ, type Db } from '../db.ts';
import { parseOpp } from '../pipeline/store.ts';
import { ask } from '../ask/ask.ts';
import { runPipeline } from '../pipeline/run.ts';
import { getSecret } from '../secrets.ts';
import { demoPaths } from '../demo.ts';
import { redactText } from '../util/log.ts';

const WEB = join(ROOT, 'web');
const STATIC: Record<string, [string, string]> = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
const isLoopback = (h: string) => /^(127\.\d+\.\d+\.\d+|localhost|::1|\[::1\])$/.test(h);
const sha = (s: string) => createHash('sha256').update(s).digest();
const safeEq = (a: string, b: string) => timingSafeEqual(sha(a), sha(b));

export interface ServerOpts { demo?: boolean; host?: string; port?: number }
export async function startServer(o: ServerOpts = {}) {
  const host = o.host ?? process.env.GOVCON_HOST ?? '127.0.0.1'; const port = o.port ?? Number(process.env.GOVCON_PORT ?? 8787);
  const token = await getSecret('GOVCON_UI_TOKEN');
  if (!isLoopback(host) && !token) throw new Error(`Refusing to listen on ${host}: set GOVCON_UI_TOKEN (a long random string) before exposing the UI beyond this computer. See SECURITY.md.`);
  const dp = demoPaths(); const dbFile = o.demo ? dp.db : paths.dbFile; const reportDir = o.demo ? dp.reports : paths.reportDir;
  if (o.demo && !existsSync(dbFile)) throw new Error('No demo data yet. Run "govcon demo" first.');
  const csrf = randomBytes(24).toString('hex'); const sessionKey = randomBytes(24).toString('hex');
  const cookieVal = () => createHash('sha256').update(sessionKey + (token ?? '')).digest('hex');
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `${host}:${port}`, ...(process.env.GOVCON_ALLOWED_HOSTS ?? '').split(',').filter(Boolean)]);
  let running = false; let lastRunMsg = '';
  const db = (): Db => openDb(dbFile);

  const send = (res: ServerResponse, code: number, body: string | Buffer, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}) => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", ...extra });
    res.end(body);
  };
  const json = (res: ServerResponse, code: number, v: unknown) => send(res, code, JSON.stringify(v));
  const readBody = (req: IncomingMessage) => new Promise<string>((ok, bad) => { let n = 0; const ch: Buffer[] = []; req.on('data', (c) => { n += c.length; if (n > 100_000) { bad(new Error('body too large')); req.destroy(); } else ch.push(c); }); req.on('end', () => ok(Buffer.concat(ch).toString('utf8'))); req.on('error', bad); });
  const authed = (req: IncomingMessage) => !token || (req.headers.cookie ?? '').split(/;\s*/).some((c) => c === `govcon_session=${cookieVal()}`);

  const server = createServer(async (req, res) => {
    try {
      const hostH = String(req.headers.host ?? ''); if (!allowedHosts.has(hostH)) return send(res, 421, JSON.stringify({ error: 'unrecognised Host header' }));
      const url = new URL(req.url ?? '/', `http://${hostH}`); const path = url.pathname; const method = req.method ?? 'GET';
      if (method === 'POST' && path === '/login') {
        const body = new URLSearchParams(await readBody(req)); const t = body.get('token') ?? '';
        if (token && safeEq(t, token)) return send(res, 303, '', 'text/plain', { location: '/', 'set-cookie': `govcon_session=${cookieVal()}; HttpOnly; SameSite=Strict; Path=/` });
        return send(res, 401, loginPage('Wrong token'), 'text/html; charset=utf-8');
      }
      if (!authed(req)) return send(res, path.startsWith('/api/') ? 401 : 200, path.startsWith('/api/') ? JSON.stringify({ error: 'login required' }) : loginPage(), path.startsWith('/api/') ? undefined : 'text/html; charset=utf-8');
      if (method === 'POST') {
        const origin = req.headers.origin; if (origin && new URL(origin).host !== hostH) return json(res, 403, { error: 'cross-origin request refused' });
        if (req.headers['x-csrf-token'] !== csrf) return json(res, 403, { error: 'missing CSRF token' });
      }
      if (method === 'GET' && STATIC[path]) {
        const [file, type] = STATIC[path]; let body = readFileSync(join(WEB, file), 'utf8');
        if (file === 'index.html') body = body.replace('__CSRF__', csrf).replace('__MODE__', o.demo ? 'demo' : 'live');
        return send(res, 200, body, type);
      }
      if (path === '/api/status') {
        const d = db(); try {
          const runs = d.all(`select id, trigger, started_at, finished_at, status, mode, counts, coverage, report_file, demo from run where dry_run=0 order by id desc limit 10`).map((r) => ({ ...r, counts: parseJ(r.counts, {}), coverage: parseJ(r.coverage, []), report_file: r.report_file ? basename(r.report_file) : null }));
          const prof = (() => { try { return loadProfile(); } catch { return null; } })();
          return json(res, 200, { mode: o.demo ? 'demo' : 'live', running, lastRunMsg, runs, schedule: prof ? { cron: prof.schedule, timezone: prof.timezone } : null, counts: d.get(`select count(*) n, sum(priority='High') hi, sum(priority='Medium') med from opp where lifecycle='active' and review_state not in ('review','dismissed')`) });
        } finally { d.close(); }
      }
      if (path === '/api/opportunities') {
        const d = db(); try {
          const w: string[] = [`lifecycle='active'`, `review_state not in ('review','dismissed')`]; const p: any[] = []; const q = url.searchParams;
          for (const [k, col] of [['department', 'department'], ['priority', 'priority'], ['classification', 'classification']] as const) if (q.get(k)) { w.push(`${col}=?`); p.push(q.get(k)); }
          if (q.get('q')) { w.push(`(title like ? or description like ?)`); p.push(`%${q.get('q')}%`, `%${q.get('q')}%`); }
          const lim = Math.min(500, Number(q.get('limit') ?? 200)); const rows = d.all(`select * from opp where ${w.join(' and ')} order by coalesce(priority_score,0) desc limit ${lim}`, p).map(parseOpp);
          const deps = d.all(`select distinct department from opp where lifecycle='active' order by 1`).map((r) => r.department);
          return json(res, 200, { departments: deps, rows: rows.map((r) => ({ id: r.id, title: r.title, department: r.department, agency: r.agency, priority: r.priority, score: r.priority_score, release: r.sol_date ?? r.fields?.derived_release ?? null, releaseBasis: r.sol_date ? r.sol_date_basis : r.fields?.derived_release ? 'derived' : 'unknown', value: r.value_usd, classification: r.classification, confidence: r.confidence, url: r.primary_url, linkType: r.url_kind })) });
        } finally { d.close(); }
      }
      const m = /^\/api\/opportunity\/(\d+)$/.exec(path);
      if (m) { const d = db(); try { const r = d.get(`select * from opp where id=?`, [Number(m[1])]); if (!r) return json(res, 404, { error: 'not found' }); const o2 = parseOpp(r); delete o2.relevance_detail?.hits; const srcs = d.all(`select source, source_id, url, update_date from source_record where opp_id=?`, [r.id]); const ch = d.all(`select kind, field, old_value, new_value, evidence, detected_at from change where opp_id=? order by id desc limit 20`, [r.id]); return json(res, 200, { ...o2, sourceRecords: srcs, changes: ch }); } finally { d.close(); } }
      if (path === '/api/ask' && method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}'); const qn = String(b.question ?? '').slice(0, 500); if (!qn.trim()) return json(res, 400, { error: 'question required' });
        const d = db(); try { const a = await ask(d, qn, loadProfile()); return json(res, 200, a); } finally { d.close(); }
      }
      if (path === '/api/reports') { const files = existsSync(reportDir) ? readdirSync(reportDir).filter((f) => f.endsWith('.xlsx')).map((f) => ({ name: f, bytes: statSync(join(reportDir, f)).size, modified: statSync(join(reportDir, f)).mtime.toISOString() })).sort((a, b) => b.modified.localeCompare(a.modified)) : []; return json(res, 200, { files }); }
      const dl = /^\/api\/reports\/([^/]+)$/.exec(path);
      if (dl) { const name = decodeURIComponent(dl[1]); const file = resolve(reportDir, name); if (!/^[\w.\- ]+\.xlsx$/.test(name) || !file.startsWith(resolve(reportDir)) || !existsSync(file)) return json(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': `attachment; filename="${name}"`, 'x-content-type-options': 'nosniff' }); return void createReadStream(file).pipe(res); }
      if (path === '/api/run' && method === 'POST') {
        if (o.demo) return json(res, 400, { error: 'disabled in demo mode' }); if (running) return json(res, 409, { error: 'a run is already in progress' });
        running = true; lastRunMsg = 'running…';
        runPipeline({ trigger: 'ui' }).then((s) => { lastRunMsg = `run ${s.runId} ${s.status}`; }).catch((e) => { lastRunMsg = `failed: ${redactText((e as Error).message)}`; }).finally(() => { running = false; });
        return json(res, 202, { started: true });
      }
      return json(res, 404, { error: 'not found' });
    } catch (e) { return json(res, 500, { error: redactText((e as Error).message) }); }
  });
  await new Promise<void>((ok, bad) => { server.once('error', bad); server.listen(port, host, ok); });
  console.log(`GovCon Intelligence Agent UI: http://${host === '::1' ? '[::1]' : host}:${port}  (${o.demo ? 'DEMO data' : 'live data'}; Ctrl+C to stop)${token ? '\nAccess token required (GOVCON_UI_TOKEN).' : ''}`);
  const stop = () => { server.close(); process.exit(0); }; process.on('SIGINT', stop); process.on('SIGTERM', stop);
  return server;
}
function loginPage(err = ''): string {
  const e = err.replace(/[<>&]/g, '');
  return `<!doctype html><meta charset="utf-8"><title>Sign in</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><main class="login"><h1>GovCon Intelligence Agent</h1><form method="post" action="/login"><label>Access token<input type="password" name="token" autocomplete="current-password" autofocus></label><button>Sign in</button>${e ? `<p class="err">${e}</p>` : ''}</form></main>`;
}
void parseJ;
