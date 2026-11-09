// Embedded SQLite via Node's built-in node:sqlite (no native add-on, no server to install).
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { paths } from './config.ts';

export const SCHEMA_VERSION = 1;
const SCHEMA = `
create table if not exists meta (key text primary key, value text);
create table if not exists run (
  id integer primary key autoincrement, trigger text not null default 'manual', dry_run integer not null default 0,
  started_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')), finished_at text,
  status text not null default 'running', window_from text, window_to text, mode text not null default 'incremental',
  coverage text not null default '[]', counts text not null default '{}', baseline_run_id integer,
  report_file text, report_bytes integer, log text not null default '[]', error text, audit text not null default '{}', demo integer not null default 0);
create table if not exists opp (
  id integer primary key autoincrement, canon_key text not null unique,
  solicitation_number text, piid text, title text not null, department text, agency text, subagency text, description text,
  sol_date text, sol_date_basis text not null default 'unknown', award_date text, award_date_basis text not null default 'unknown',
  value_usd real, value_type text, value_note text, value_kind text not null default 'procurement', counted_value_usd real,
  set_aside text, instrument text, vehicle text, duration text, naics text, psc text, status text,
  classification text not null default 'unknown', incumbent text not null default '{}', indicators text not null default '[]',
  matched_keywords text not null default '[]', keyword_category text, relevance real, relevance_detail text not null default '{}',
  priority text, priority_score integer, priority_detail text not null default '{}', confidence text, gaps text not null default '[]',
  sources text not null default '[]', primary_url text, url_kind text, source_updated text,
  first_discovered text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')), last_seen_run integer, last_seen_at text,
  lifecycle text not null default 'active', review_state text not null default 'none', fields text not null default '{}',
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
create index if not exists opp_dept on opp(department, lifecycle);
create index if not exists opp_sol on opp(solicitation_number);
create index if not exists opp_piid on opp(piid);
create table if not exists source_record (
  id integer primary key autoincrement, opp_id integer not null references opp(id) on delete cascade,
  source text not null, source_id text not null, url text, update_date text,
  fetched_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')), payload text not null default '{}', unique(source, source_id));
create index if not exists sr_opp on source_record(opp_id);
create table if not exists snapshot (id integer primary key autoincrement, opp_id integer not null references opp(id) on delete cascade,
  run_id integer not null references run(id) on delete cascade, taken_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')), fields text not null, unique(opp_id, run_id));
create table if not exists change (id integer primary key autoincrement, run_id integer not null references run(id) on delete cascade,
  opp_id integer references opp(id) on delete cascade, kind text not null, field text, old_value text, new_value text, evidence text,
  material integer not null default 1, detected_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
create index if not exists change_run on change(run_id);
create table if not exists signal (id integer primary key autoincrement, source text not null, title text not null, url text not null unique,
  published text, summary text, fetched_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
create table if not exists llm_usage (id integer primary key autoincrement, at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  provider text, model text, purpose text, input_tokens integer, output_tokens integer, est_cost_usd real);
create table if not exists http_cache (key text primary key, value text not null, fetched_at text not null, expires_at text not null);
`;

export type Row = Record<string, any>;
export class Db {
  raw: DatabaseSync;
  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.raw = new DatabaseSync(file);
    this.raw.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;');
    this.raw.exec(SCHEMA);
    const v = this.get('select value from meta where key=?', ['schema_version']);
    if (!v) this.run('insert into meta(key,value) values (?,?)', ['schema_version', String(SCHEMA_VERSION)]);
    else if (Number(v.value) > SCHEMA_VERSION) throw new Error(`This database was written by a newer version (schema ${v.value}); upgrade the application.`);
    // future migrations: if (Number(v.value) < 2) { ...; update meta }
  }
  run(sql: string, params: SQLInputValue[] = []) { return this.raw.prepare(sql).run(...params); }
  get(sql: string, params: SQLInputValue[] = []): Row | undefined { return this.raw.prepare(sql).get(...params) as Row | undefined; }
  all(sql: string, params: SQLInputValue[] = []): Row[] { return this.raw.prepare(sql).all(...params) as Row[]; }
  private seq = 0;
  /** Transaction that nests (inside an open transaction it becomes a savepoint), so dry runs can wrap everything and roll back. */
  tx<T>(fn: () => T): T {
    const nested = this.raw.isTransaction; const sp = `sp${++this.seq}`;
    this.raw.exec(nested ? `savepoint ${sp}` : 'begin');
    try { const r = fn(); this.raw.exec(nested ? `release ${sp}` : 'commit'); return r; }
    catch (e) { try { this.raw.exec(nested ? `rollback to ${sp}; release ${sp}` : 'rollback'); } catch { /* connection closed */ } throw e; }
  }
  close() { try { this.raw.close(); } catch { /* ignore */ } }
  getSetting<T>(key: string, d: T): T { const r = this.get('select value from meta where key=?', ['s:' + key]); return r ? (JSON.parse(r.value) as T) : d; }
  setSetting(key: string, v: unknown) { this.run('insert into meta(key,value) values (?,?) on conflict(key) do update set value=excluded.value', ['s:' + key, JSON.stringify(v)]); }
}
export const J = (v: unknown) => JSON.stringify(v ?? null);
export const parseJ = <T = any>(s: unknown, d: T): T => { try { return s == null ? d : (JSON.parse(String(s)) as T); } catch { return d; } };

let shared: Db | null = null;
export function openDb(file = paths.dbFile): Db { return new Db(file); }
export function getDb(): Db { return (shared ??= openDb()); }
export function closeDb() { shared?.close(); shared = null; }
