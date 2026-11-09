// HTTP helper: timeout, bounded retries with backoff, per-host spacing, optional SQLite response cache, URL redaction in errors.
import { createHash } from 'node:crypto';
import type { Db } from '../db.ts';
import { logger, redactText } from './log.ts';

export const USER_AGENT = 'govcon-intelligence-agent/1.0 (+https://github.com/junwalla73/govcon-intelligence-agent; open-source research tool)';
const lastCall = new Map<string, number>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FetchOpts {
  method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: unknown; timeoutMs?: number;
  retries?: number; minIntervalMs?: number; cacheTtlSec?: number; db?: Db; noCache?: boolean; as?: 'json' | 'text';
}
export class HttpError extends Error {
  status: number; retryable: boolean;
  constructor(status: number, msg: string, retryable: boolean) { super(redactText(msg)); this.status = status; this.retryable = retryable; }
}
export async function fetchData<T = any>(url: string, o: FetchOpts = {}): Promise<{ data: T; cached: boolean; fetchedAt: Date }> {
  const method = o.method ?? 'GET';
  const cacheKey = o.cacheTtlSec && o.db ? createHash('sha256').update(`${method} ${url} ${o.body ? JSON.stringify(o.body) : ''}`).digest('hex') : null;
  if (cacheKey && o.db && !o.noCache) {
    const hit = o.db.get(`select value, fetched_at from http_cache where key=? and expires_at > ?`, [cacheKey, new Date().toISOString()]);
    if (hit) return { data: (o.as === 'text' ? hit.value : JSON.parse(hit.value)) as T, cached: true, fetchedAt: new Date(hit.fetched_at) };
  }
  const host = new URL(url).host; const retries = o.retries ?? 3; let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const wait = (lastCall.get(host) ?? 0) + (o.minIntervalMs ?? 250) - Date.now(); if (wait > 0) await sleep(wait);
    lastCall.set(host, Date.now());
    try {
      const res = await fetch(url, { method, signal: AbortSignal.timeout(o.timeoutMs ?? 30000), redirect: 'follow',
        headers: { 'user-agent': USER_AGENT, accept: o.as === 'text' ? '*/*' : 'application/json', ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...o.headers },
        body: o.body === undefined ? undefined : JSON.stringify(o.body) });
      if (!res.ok) {
        const txt = (await res.text().catch(() => '')).slice(0, 300); const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < retries) { const ra = Number(res.headers.get('retry-after')); await sleep(ra ? Math.min(ra, 60) * 1000 : 500 * 2 ** attempt); continue; }
        throw new HttpError(res.status, `HTTP ${res.status} from ${host}: ${txt}`, retryable);
      }
      const text = await res.text(); const data = (o.as === 'text' ? text : JSON.parse(text)) as T; const fetchedAt = new Date();
      if (cacheKey && o.db) o.db.run(`insert into http_cache(key,value,fetched_at,expires_at) values (?,?,?,?) on conflict(key) do update set value=excluded.value, fetched_at=excluded.fetched_at, expires_at=excluded.expires_at`,
        [cacheKey, text, fetchedAt.toISOString(), new Date(fetchedAt.getTime() + o.cacheTtlSec! * 1000).toISOString()]);
      return { data, cached: false, fetchedAt };
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpError && !e.retryable) throw e;
      if (attempt < retries) { logger.warn('http retry', { host, attempt, err: (e as Error).message }); await sleep(500 * 2 ** attempt); }
    }
  }
  throw new HttpError(-1, lastErr instanceof Error ? lastErr.message : 'request failed', true);
}
