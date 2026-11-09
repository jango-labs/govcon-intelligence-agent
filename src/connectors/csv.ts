// Generic CSV import connector: bring your own export (from any tool you are licensed to use) and map its columns.
// This is the supported way to feed licensed/commercial data into the pipeline without any vendor-specific code in this repository.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeOrg } from '../scope.ts';
import { toDate, classHint } from './shared.ts';
import type { Connector, Candidate, DiscoverContext } from '../types.ts';
import { ROOT } from '../config.ts';

/** RFC-4180-ish CSV parser (quotes, escaped quotes, CRLF, embedded newlines). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cur = '', q = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) { if (ch === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && src[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((c) => c !== '')) rows.push(row); row = []; }
    else cur += ch;
  }
  row.push(cur); if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}
/** Canonical field → accepted header names (case/space-insensitive). Override per file with "mapping": { "title": "My Column" }. */
export const DEFAULT_HEADERS: Record<string, string[]> = {
  id: ['id', 'opportunity id', 'source id', 'record id'], title: ['title', 'opportunity name', 'name', 'opportunity title'], description: ['description', 'summary', 'opportunity description'],
  department: ['department', 'dept'], agency: ['agency', 'organization', 'buying organization', 'sub-agency', 'subagency'], solicitationNumber: ['solicitation number', 'solicitation', 'solicitation #', 'rfp number'],
  solDate: ['solicitation date', 'rfp date', 'expected solicitation release date', 'release date', 'solicitation release'], awardDate: ['award date', 'expected award date', 'approximate award date'],
  valueUsd: ['value', 'estimated value', 'opportunity value', 'value usd', 'total value'], setAside: ['set-aside', 'set aside', 'competition type'], naics: ['naics', 'primary naics'], psc: ['psc'],
  vehicle: ['vehicle', 'contract vehicle'], status: ['status', 'stage'], incumbent: ['incumbent', 'incumbent name'], incumbentPiid: ['incumbent piid', 'incumbent contract', 'piid', 'contract number'],
  incumbentEnd: ['incumbent end date', 'contract end date', 'expiration date', 'incumbent expiration'], url: ['url', 'link', 'source link'], type: ['type', 'instrument', 'contract type'],
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();
export function candidatesFromCsv(text: string, name: string, mapping: Record<string, string> = {}): Candidate[] {
  const rows = parseCsv(text); if (rows.length < 2) return [];
  const head = rows[0].map(norm); const col = (k: string) => { const want = [mapping[k], ...(DEFAULT_HEADERS[k] ?? [])].filter(Boolean).map((x) => norm(x as string)); return head.findIndex((h) => want.includes(h)); };
  const idx = Object.fromEntries(Object.keys(DEFAULT_HEADERS).map((k) => [k, col(k)])) as Record<string, number>;
  const get = (r: string[], k: string) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '');
  const out: Candidate[] = [];
  for (const [n, r] of rows.slice(1).entries()) {
    const title = get(r, 'title'); if (!title) continue;
    const org = normalizeOrg(get(r, 'department'), get(r, 'agency')); const val = Number(get(r, 'valueUsd').replace(/[$,\s]/g, ''));
    const url = /^https?:\/\//i.test(get(r, 'url')) ? get(r, 'url') : undefined; const incName = get(r, 'incumbent');
    const sid = get(r, 'id') || createHash('sha1').update(`${name}|${title}|${get(r, 'solicitationNumber')}|${n}`).digest('hex').slice(0, 12);
    out.push({ source: 'csv_import', sourceId: `${name}:${sid}`, url, urlKind: url ? 'record' : 'none', title, description: get(r, 'description'), department: org.department ?? (get(r, 'department') || null), agency: org.department ? org.agency : get(r, 'agency'), subagency: org.subagency,
      solicitationNumber: get(r, 'solicitationNumber') || undefined, solDate: toDate(get(r, 'solDate')), solBasis: toDate(get(r, 'solDate')) ? 'imported' : 'unknown', awardDate: toDate(get(r, 'awardDate')), awardBasis: toDate(get(r, 'awardDate')) ? 'imported' : 'unknown',
      valueUsd: Number.isFinite(val) && val > 0 ? val : null, valueType: Number.isFinite(val) && val > 0 ? 'imported value (as supplied; not verified)' : undefined, setAside: get(r, 'setAside') || undefined, naics: get(r, 'naics') || undefined, psc: get(r, 'psc') || undefined,
      vehicle: get(r, 'vehicle') || undefined, instrument: get(r, 'type') || undefined, status: get(r, 'status') || undefined, stage: 'imported',
      incumbent: incName ? { name: incName, piid: get(r, 'incumbentPiid') || undefined, endDate: toDate(get(r, 'incumbentEnd')) ?? undefined, source: `imported file "${name}" (as supplied)` } : undefined,
      ...(incName ? { classHint: 'likely_recompete' as const, classEvidence: 'imported file names an incumbent' } : classHint(`${title} ${get(r, 'description')}`)), raw: { file: name, row: n + 2 } });
  }
  return out;
}
export const csvConnector: Connector = {
  id: 'csv_import', name: 'CSV imports', access: 'file',
  async discover(ctx: DiscoverContext) {
    const NAME = 'CSV imports'; const cfg = ctx.profile.sources.csvImports;
    if (!cfg.enabled || !cfg.files.length) return { candidates: [], coverage: { source: NAME, status: 'skipped', detail: 'no CSV files configured (sources.csvImports.files)' } };
    const out: Candidate[] = []; const notes: string[] = []; let bad = 0;
    for (const f of cfg.files) {
      const p = resolve(process.env.GOVCON_HOME ?? ROOT, f.path);
      if (!existsSync(p)) { bad++; notes.push(`${f.path}: file not found`); continue; }
      try { const c = candidatesFromCsv(readFileSync(p, 'utf8'), f.name ?? f.path.replace(/^.*[\\/]/, ''), f.mapping); out.push(...c); notes.push(`${f.name ?? f.path}: ${c.length} rows`); } catch (e) { bad++; notes.push(`${f.path}: ${(e as Error).message}`); }
    }
    return { candidates: out, coverage: { source: NAME, status: bad ? (out.length ? 'partial' : 'failed') : 'ok', detail: notes.join('; '), fetched: out.length } };
  },
};
