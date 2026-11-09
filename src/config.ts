// Configuration: environment variables (+ optional .env file) for secrets and paths, and a JSON "profile" for what to look for.
// Nothing here talks to the network, and nothing hard-codes a person, company or machine.
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PRIORITY_WEIGHTS, DEFAULT_THRESHOLDS, type PriorityWeights, type PriorityThresholds } from './priority.ts';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env parser (KEY=value, quotes optional, # comments). Real environment variables always win. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line); if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}
let envLoaded = false;
export function loadEnvFile(file = join(process.env.GOVCON_HOME ?? ROOT, '.env')): void {
  if (envLoaded) return; envLoaded = true;
  if (!existsSync(file)) return;
  for (const [k, v] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) if (process.env[k] === undefined && v !== '') process.env[k] = v;
}
loadEnvFile();

const abs = (p: string) => resolve(process.env.GOVCON_HOME ?? ROOT, p);
export const paths = {
  get dataDir() { const d = abs(process.env.GOVCON_DATA_DIR ?? './data'); mkdirSync(d, { recursive: true }); return d; },
  get dbFile() { return process.env.GOVCON_DB_FILE ? abs(process.env.GOVCON_DB_FILE) : join(this.dataDir, 'govcon.sqlite'); },
  get reportDir() { const d = process.env.GOVCON_REPORT_DIR ? abs(process.env.GOVCON_REPORT_DIR) : join(this.dataDir, 'reports'); mkdirSync(d, { recursive: true }); return d; },
  get profileFile() { return abs(process.env.GOVCON_PROFILE ?? './config/profile.json'); },
  examplesProfile: join(ROOT, 'config', 'profile.example.json'),
  sampleDir: join(ROOT, 'data', 'sample'),
};

export interface KeywordDef { term: string; category?: string; synonyms?: string[]; exclusions?: string[]; weight?: number; enabled?: boolean }
export interface Profile {
  profileName: string; timezone: string; schedule: string; windowMonths: number;
  scope: { departments: string[]; excludeComponents: string[]; otherAgencyForecasts: boolean };
  filters: { naics: string[]; naicsMode: 'prefer' | 'require'; noticeTypes: string[]; setAsides: string[]; vehicles: string[]; minValueUsd: number | null };
  keywords: KeywordDef[];
  relevance: { threshold: number; evidence: 'strong' | 'any'; reviewNaicsForecasts: boolean };
  priority: { weights: PriorityWeights; thresholds: PriorityThresholds };
  derive: { rfpLeadMonths: number; minExpiry: string | null };
  changeThresholds: { dateShiftDays: number; valueChangePct: number };
  sources: {
    sam: { enabled: boolean; lookbackDays: number; maxCalls: number; fetchDescriptions: number };
    usaspending: { enabled: boolean; expiringContracts: boolean; maxCalls: number; expiringWithinMonths: number; maxKeywords: number; lookbackYears: number };
    gsaForecast: { enabled: boolean; maxPages: number };
    gao: { enabled: boolean };
    csvImports: { enabled: boolean; files: { path: string; name?: string; mapping?: Record<string, string> }[] };
    plugins: string[];
  };
  llm: { provider: 'none' | 'ollama' | 'anthropic' | 'openai'; model: string; monthlyCapUsd: number };
}

export const DEFAULT_PROFILE: Profile = {
  profileName: 'Default profile', timezone: 'America/New_York', schedule: '0 6 * * *', windowMonths: 24,
  scope: { departments: ['DoD', 'DHS', 'DOJ', 'HHS', 'VA'], excludeComponents: [], otherAgencyForecasts: true },
  filters: { naics: ['541511', '541512', '541513', '541519', '518210', '541330', '541690', '541715'], naicsMode: 'prefer', noticeTypes: [], setAsides: [], vehicles: [], minValueUsd: null },
  keywords: [],
  relevance: { threshold: 25, evidence: 'strong', reviewNaicsForecasts: true },
  priority: { weights: { ...DEFAULT_PRIORITY_WEIGHTS }, thresholds: { ...DEFAULT_THRESHOLDS } },
  derive: { rfpLeadMonths: 6, minExpiry: null },
  changeThresholds: { dateShiftDays: 14, valueChangePct: 20 },
  sources: {
    sam: { enabled: true, lookbackDays: 364, maxCalls: 60, fetchDescriptions: 20 },
    usaspending: { enabled: true, expiringContracts: true, maxCalls: 40, expiringWithinMonths: 24, maxKeywords: 12, lookbackYears: 6 },
    gsaForecast: { enabled: true, maxPages: 160 },
    gao: { enabled: true },
    csvImports: { enabled: true, files: [] },
    plugins: [],
  },
  llm: { provider: 'none', model: '', monthlyCapUsd: 0 },
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function deepMerge<T>(base: T, over: unknown): T {
  if (!isObj(base) || !isObj(over)) return (over === undefined ? base : (over as T));
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out as T;
}

export class ProfileError extends Error {}
/** Validate a profile; returns human-readable problems (empty = OK). */
export function validateProfile(p: Profile): string[] {
  const bad: string[] = [];
  if (!Array.isArray(p.keywords) || !p.keywords.length) bad.push('keywords: add at least one keyword (config/profile.json → "keywords")');
  for (const k of p.keywords ?? []) if (!k?.term || typeof k.term !== 'string') bad.push('keywords: every keyword needs a "term"');
  if (!Number.isFinite(p.windowMonths) || p.windowMonths < 1 || p.windowMonths > 60) bad.push('windowMonths must be between 1 and 60');
  if (p.schedule && p.schedule.trim().split(/\s+/).length !== 5) bad.push('schedule must be a 5-field cron expression such as "0 6 * * *"');
  try { new Intl.DateTimeFormat('en-US', { timeZone: p.timezone }); } catch { bad.push(`timezone "${p.timezone}" is not a valid IANA time zone (for example America/New_York)`); }
  const w = p.priority.weights; for (const k of Object.keys(DEFAULT_PRIORITY_WEIGHTS) as (keyof PriorityWeights)[]) if (!(w[k] >= 0)) bad.push(`priority.weights.${k} must be a number >= 0`);
  const t = p.priority.thresholds; if (!(t.high > t.medium && t.medium > t.low && t.low >= 0)) bad.push('priority.thresholds must satisfy high > medium > low >= 0');
  for (const n of p.filters.naics) if (!/^\d{2,6}$/.test(n)) bad.push(`filters.naics: "${n}" is not a NAICS code`);
  if (!['none', 'ollama', 'anthropic', 'openai'].includes(p.llm.provider)) bad.push('llm.provider must be none, ollama, anthropic or openai');
  return bad;
}

export function loadProfile(file = paths.profileFile): Profile {
  const f = existsSync(file) ? file : null;
  if (!f) throw new ProfileError(`No profile found at ${file}. Run "npm run setup" (or copy config/profile.example.json to config/profile.json).`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { throw new ProfileError(`${f} is not valid JSON: ${(e as Error).message}`); }
  const p = deepMerge(DEFAULT_PROFILE, raw);
  p.keywords = (p.keywords ?? []).filter((k) => k.enabled !== false);
  if (process.env.GOVCON_LLM_PROVIDER) p.llm.provider = process.env.GOVCON_LLM_PROVIDER as Profile['llm']['provider'];
  if (process.env.GOVCON_LLM_MODEL) p.llm.model = process.env.GOVCON_LLM_MODEL;
  if (process.env.GOVCON_LLM_MONTHLY_CAP_USD) p.llm.monthlyCapUsd = Number(process.env.GOVCON_LLM_MONTHLY_CAP_USD) || 0;
  const problems = validateProfile(p);
  if (problems.length) throw new ProfileError(`Profile problems:\n - ${problems.join('\n - ')}`);
  return p;
}
export function loadExampleProfile(): Profile { return loadProfile(paths.examplesProfile); }
