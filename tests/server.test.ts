import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { tmp, profile } from './helpers.ts';
import { demo, demoPaths } from '../src/demo.ts';
import { startServer } from '../src/server/app.ts';
import { request } from 'node:http';

let base = ''; let port = 0; let csrf = ''; let srv: any;
const get = (path: string, o: { host?: string; method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<{ status: number; body: string; headers: any }>((res, rej) => {
  const r = request({ host: '127.0.0.1', port, path, method: o.method ?? 'GET', headers: { host: o.host ?? `127.0.0.1:${port}`, ...(o.headers ?? {}) } }, (rs) => { let b = ''; rs.on('data', (c) => (b += c)); rs.on('end', () => res({ status: rs.statusCode!, body: b, headers: rs.headers })); });
  r.on('error', rej); if (o.body) r.write(o.body); r.end();
});
beforeAll(async () => {
  process.env.GOVCON_DATA_DIR = tmp(); process.env.GOVCON_PROFILE = join(process.cwd(), 'config', 'profile.example.json'); mkdirSync(demoPaths().dir, { recursive: true });
  await demo({ quiet: true });
  port = 20000 + Math.floor(Math.random() * 20000); srv = await startServer({ demo: true, host: '127.0.0.1', port });
  csrf = /name="csrf" content="([0-9a-f]+)"/.exec((await get('/')).body)![1];
});
afterAll(() => { srv?.close(); });
describe('local web UI security', () => {
  it('serves the app and JSON with security headers', async () => {
    const r = await get('/'); expect(r.status).toBe(200); expect(r.headers['content-security-policy']).toContain("default-src 'self'"); expect(r.headers['x-frame-options']).toBe('DENY');
    const o = JSON.parse((await get('/api/opportunities?priority=High')).body); expect(o.rows.length).toBeGreaterThan(0); expect(o.rows.every((x: any) => x.priority === 'High')).toBe(true);
  });
  it('rejects unknown Host headers (DNS rebinding) and POSTs without the CSRF token or from other origins', async () => {
    expect((await get('/api/status', { host: 'evil.example' })).status).toBe(421);
    expect((await get('/api/ask', { method: 'POST', body: '{"question":"help"}' })).status).toBe(403);
    expect((await get('/api/ask', { method: 'POST', headers: { 'x-csrf-token': csrf, origin: 'http://evil.example' }, body: '{"question":"help"}' })).status).toBe(403);
    const ok = await get('/api/ask', { method: 'POST', headers: { 'x-csrf-token': csrf, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: '{"question":"help"}' }); expect(ok.status).toBe(200); expect(JSON.parse(ok.body).text).toContain('Examples');
  });
  it('demo mode cannot trigger live runs, and report downloads cannot escape the folder', async () => {
    expect((await get('/api/run', { method: 'POST', headers: { 'x-csrf-token': csrf } })).status).toBe(400);
    expect((await get('/api/reports/..%2F..%2Fpackage.json')).status).toBe(404); expect((await get('/api/reports/passwd')).status).toBe(404);
    const list = JSON.parse((await get('/api/reports')).body); expect(list.files.length).toBeGreaterThan(0);
    const dl = await get('/api/reports/' + encodeURIComponent(list.files[0].name)); expect(dl.status).toBe(200); expect(dl.headers['content-type']).toContain('spreadsheetml');
  });
  it('refuses to listen beyond loopback without an access token', async () => {
    await expect(startServer({ demo: true, host: '0.0.0.0', port: port + 1 })).rejects.toThrow(/GOVCON_UI_TOKEN/);
  });
});
