// Excel deliverable: GovCon_Pipeline_YYYY-MM-DD.xlsx — seven worksheets, typed dates/numbers, no macros, no formulas, no external links except source URLs.
import ExcelJS from 'exceljs';
import { mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Db, parseJ } from '../db.ts';
import { paths, type Profile } from '../config.ts';
import { parseOpp } from './store.ts';
import { VEHICLE_VALUE_TYPE } from '../derive.ts';
import type { SourceCoverage } from '../types.ts';

export interface ReportMeta {
  runId: number; asOf: Date; status: 'complete' | 'partial' | 'failed'; coverage: SourceCoverage[]; windowFrom: string; windowTo: string; mode: string;
  baselineRunId: number | null; baselineStatus: string | null; dry: boolean; demo: boolean; counts: Record<string, number>; thresholds: { dateDays: number; valuePct: number }; audit?: any; profile: Profile;
}
export const MASTER_COLUMNS = ['Opportunity Name', 'Department', 'Agency', 'Subagency / Buying Organization', 'Opportunity Description', 'Expected Solicitation Release Date', 'Approximate Award Date', 'Estimated Opportunity Value', 'Value Type', 'Competition Type / Set-Aside',
  'Procurement Instrument Type', 'Contract Vehicle', 'Contract Duration', 'Primary NAICS', 'PSC', 'New Contract / Recompete Classification', 'Incumbent Name', 'Incumbent UEI', 'Incumbent Contract Number / PIID', 'Incumbent Parent Contract / Vehicle',
  'Incumbent Contract Value', 'Incumbent Value Type', 'Incumbent Award Date', 'Incumbent Expected Completion Date', 'Incumbent Obligations (official source)', 'Options Remaining', 'External ID (imported / plugin)', 'Solicitation Number', 'Current Status',
  'Matched Keywords', 'Keyword Category', 'Relevance Score', 'Opportunity Intelligence Priority', 'Estimated Annual Value', 'Days Until Release', 'Source(s)', 'Primary Source Link', 'Link Type', 'Last Source Updated', 'Date First Discovered', 'Change Since Previous Successful Report',
  'Data Confidence', 'Date Basis (release)', 'Intelligence Gaps / Notes'] as const;
const EXTRA = ['Canonical ID', 'Lifecycle', 'Review State', 'Value Counted in Totals', 'Priority Score', 'Configured Vehicle Match', 'Run ID', 'All Source IDs'];
export const SHEETS = ['01 Executive Summary', '02 Master Opportunities', '03 New & Changed', '04 Recompetes', '05 18-24 Month Outlook', '06 Capture Priorities', '07 Data Quality'];
const CLASS_LABEL: Record<string, string> = { confirmed_recompete: 'Confirmed recompete', likely_recompete: 'Likely recompete', possible_followon: 'Possible follow-on', expiring_no_followon: 'Contract expiring — no follow-on identified', new_requirement: 'New requirement', unknown: 'Unknown' };
const SRC_LABEL: Record<string, string> = { sam_notice: 'SAM.gov notice', gsa_forecast: 'GSA Acquisition Gateway forecast', usaspending_award: 'USAspending award record', csv_import: 'Imported CSV', sample: 'Synthetic demo data' };
const BASIS_LABEL: Record<string, string> = { government: 'Government-posted (verified)', government_estimate: 'Agency estimate', imported: 'Imported (unverified)', unknown: 'Unknown', estimate: 'Estimate' };
const URL_LABEL: Record<string, string> = { record: 'Direct record link', listing: 'Source listing page (search for title/ID)', none: 'No link' };
const NAVY = 'FF1F3A5F', TEAL = 'FF0F766E', GREY = 'FFF3F4F6', AMBER = 'FFFEF3C7';
const dOnly = (v: unknown): Date | null => { if (!v) return null; const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v)); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
const dt = (v: unknown): Date | null => { if (!v) return null; const d = new Date(String(v)); return Number.isNaN(d.getTime()) ? null : d; };
const concise = (s: unknown, n = 420) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : t; };
const days = (a: string, b: string) => Math.round((new Date(b).getTime() - new Date(a).getTime()) / 864e5);
export const dateInTz = (d: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const usd = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
function annualValue(v: unknown, duration: unknown): number | null {
  const n = Number(v); if (!n || !duration) return null; const s = String(duration); const y = /(\d+(?:\.\d+)?)\s*(?:years?|yrs?)/i.exec(s); const m = /(\d+)\s*months?/i.exec(s);
  const yrs = y ? Number(y[1]) : m ? Number(m[1]) / 12 : null; return yrs && yrs > 0 ? Math.round(n / yrs) : null;
}
/** Release-timing bucket used by the Executive Summary and the Outlook sheet. */
export function bucket(o: any, today: string): string {
  const d = o.sol_date ?? o.fields?.derived_release ?? null;
  if (!d) return o.incumbent?.endDate ? 'Contract expires (no release date)' : 'No date known';
  const m = days(today, String(d).slice(0, 10)) / 30.44;
  return m < 0 ? 'Released / date passed' : m <= 6 ? '0–6 months' : m <= 12 ? '6–12 months' : m <= 18 ? '12–18 months' : m <= 24 ? '18–24 months' : 'Beyond 24 months';
}
export const BUCKETS = ['Released / date passed', '0–6 months', '6–12 months', '12–18 months', '18–24 months', 'Beyond 24 months', 'Contract expires (no release date)', 'No date known'];

function banner(ws: ExcelJS.Worksheet, title: string, meta: ReportMeta, width: number) {
  ws.getCell('A1').value = title; ws.getCell('A1').font = { bold: true, size: 15, color: { argb: NAVY } };
  ws.getCell('A2').value = `Run ${meta.runId} • generated ${meta.asOf.toISOString().slice(0, 16).replace('T', ' ')} UTC • window ${meta.windowFrom} → ${meta.windowTo} • status ${meta.status.toUpperCase()}${meta.dry ? ' • DRY RUN' : ''}`; ws.getCell('A2').font = { size: 9, color: { argb: 'FF6B7280' } };
  let r = 3;
  if (meta.demo) { ws.getCell('A3').value = 'SYNTHETIC DEMO DATA — every opportunity, company, contract number and link in this workbook is invented. Not real procurement data.'; ws.getCell('A3').font = { bold: true, color: { argb: 'FFB91C1C' } }; r = 4; }
  if (meta.status !== 'complete') { ws.getCell(`A${r}`).value = `⚠ ${meta.status.toUpperCase()} RUN — some sources were unavailable (see sheet 07). Absence from this report does not mean an opportunity is gone.`; ws.getCell(`A${r}`).font = { bold: true, color: { argb: 'FFB45309' } }; }
  void width;
}
function styleHeader(row: ExcelJS.Row) { row.eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; c.alignment = { wrapText: true, vertical: 'middle' }; }); row.height = 34; }
const widths = (ws: ExcelJS.Worksheet, w: number[]) => w.forEach((x, i) => { ws.getColumn(i + 1).width = x; });
function linkCell(c: ExcelJS.Cell, url: unknown, text = 'Open') { if (url && /^https?:\/\//i.test(String(url))) { c.value = { text, hyperlink: String(url) }; c.font = { color: { argb: 'FF1D4ED8' }, underline: true }; } else c.value = null; }
function table(ws: ExcelJS.Worksheet, headRow: number, head: string[], rows: any[][], name?: string) {
  head.forEach((h, i) => { ws.getCell(headRow, i + 1).value = h; }); styleHeader(ws.getRow(headRow));
  rows.forEach((r, i) => r.forEach((v, j) => { if (v !== null && v !== undefined) ws.getCell(headRow + 1 + i, j + 1).value = v as any; }));
  ws.autoFilter = { from: { row: headRow, column: 1 }, to: { row: headRow, column: head.length } }; void name;
}

export async function buildWorkbook(db: Db, meta: ReportMeta, outDir?: string): Promise<{ file: string; bytes: number; rows: number; validation: { ok: boolean; problems: string[]; stats: Record<string, unknown> } }> {
  const today = dateInTz(meta.asOf, meta.profile.timezone);
  const all = db.all(`select * from opp order by coalesce(priority_score,0) desc, id`).map(parseOpp);
  const idsBy = new Map<number, string[]>(); for (const r of db.all(`select opp_id, source, source_id from source_record`)) { const a = idsBy.get(r.opp_id) ?? []; a.push(`${SRC_LABEL[r.source] ?? r.source} ${r.source_id}`); idsBy.set(r.opp_id, a); }
  const inWin = all.filter((o) => o.lifecycle === 'active' && o.review_state !== 'review' && o.review_state !== 'dismissed');
  const review = all.filter((o) => o.lifecycle === 'active' && o.review_state === 'review');
  const changes = db.all(`select c.*, o.title, o.department, o.agency, o.primary_url, o.review_state from change c left join opp o on o.id=c.opp_id where c.run_id > ? and c.run_id <= ? order by c.detected_at, c.id`, [meta.baselineRunId ?? 0, meta.runId])
    .filter((c) => !(['new', 'changed'].includes(c.kind) && ['review', 'dismissed'].includes(String(c.review_state))));   // review-queue items are not part of the report body
  const chByOpp = new Map<number, any[]>(); for (const c of changes) { if (!c.opp_id) continue; const a = chByOpp.get(c.opp_id) ?? []; a.push(c); chByOpp.set(c.opp_id, a); }
  const wb = new ExcelJS.Workbook(); wb.creator = 'govcon-intelligence-agent'; wb.created = meta.asOf; wb.title = `GovCon Pipeline ${today}`;
  const ws1 = wb.addWorksheet(SHEETS[0], { properties: { tabColor: { argb: TEAL } } });

  // ───── 02 Master ─────
  const wsM = wb.addWorksheet(SHEETS[1], { views: [{ state: 'frozen', ySplit: 5, xSplit: 1 }] });
  banner(wsM, 'Master Opportunities — complete daily view', meta, MASTER_COLUMNS.length);
  const changeText = (o: any) => { const cs = chByOpp.get(o.id) ?? []; if (!meta.baselineRunId) return 'New (first report; no baseline)'; if (!cs.length) return 'Unchanged'; return cs.map((c) => c.kind === 'new' ? 'NEW' : c.kind === 'changed' ? `${c.field}: ${c.old_value ?? '—'} → ${c.new_value ?? '—'}${c.material ? '' : ' (minor)'}` : String(c.kind).replace(/_/g, ' ')).join('; '); };
  const row = (o: any) => {
    const derived = !o.sol_date && !o.award_date && o.fields?.derived_release ? String(o.fields.derived_release) : null; const rel = o.sol_date ?? derived; const inc = o.incumbent ?? {};
    return [o.title, o.department, o.agency, o.subagency || null, concise(o.description), dOnly(rel), dOnly(o.award_date), o.value_usd == null ? null : Number(o.value_usd), o.value_kind === 'vehicle_ceiling' ? VEHICLE_VALUE_TYPE : o.value_type, o.set_aside, o.instrument, o.vehicle, o.duration, o.naics, o.psc, CLASS_LABEL[o.classification] ?? o.classification,
      inc.name ?? null, inc.uei ?? null, inc.piid ?? null, inc.parentVehicle ?? null, inc.value == null ? null : Math.round(Number(inc.value)), inc.valueType ?? null, dOnly(inc.awardDate), dOnly(inc.endDate), inc.obligations == null ? null : Math.round(Number(inc.obligations)), inc.optionsRemaining ?? null, null, o.solicitation_number, o.status,
      (o.matched_keywords ?? []).join('; '), o.keyword_category, o.relevance == null ? null : Number(o.relevance), o.priority, o.value_kind === 'vehicle_ceiling' ? null : annualValue(o.value_usd, o.duration), rel && String(rel) >= today ? days(today, String(rel)) : null,
      (o.sources ?? []).map((s: string) => SRC_LABEL[s] ?? s).join('; '), o.primary_url, URL_LABEL[o.url_kind ?? 'none'], dt(o.source_updated), dt(o.first_discovered), changeText(o), o.confidence,
      derived ? 'DERIVED estimate (contract expiration − lead time)' : BASIS_LABEL[o.sol_date_basis ?? 'unknown'] ?? o.sol_date_basis, (o.gaps ?? []).join(' • ')];
  };
  const rowsM = inWin.map((o) => [...row(o), `OPP-${o.id}`, o.lifecycle, o.review_state, o.counted_value_usd == null ? null : Number(o.counted_value_usd), o.priority_score ?? null, (o.fields?.vehicle_match ?? []).join('; ') || null, meta.runId, (idsBy.get(o.id) ?? []).join(' | ')]);
  const cols = [...MASTER_COLUMNS, ...EXTRA];
  if (rowsM.length) wsM.addTable({ name: 'MasterOpportunities', ref: 'A5', headerRow: true, totalsRow: false, style: { theme: 'TableStyleMedium2', showRowStripes: true }, columns: cols.map((c) => ({ name: c, filterButton: true })), rows: rowsM as any });
  else { cols.forEach((c, i) => { wsM.getCell(5, i + 1).value = c; }); styleHeader(wsM.getRow(5)); wsM.getCell('A6').value = meta.status === 'complete' ? 'No opportunities matched the configured scope and keywords in this run.' : `No opportunities to show: this run was ${meta.status.toUpperCase()}; see sheet 07.`; wsM.getCell('A6').font = { italic: true, color: { argb: 'FFB45309' } }; }
  styleHeader(wsM.getRow(5));
  const iDate = [6, 7, 23, 24], iMoney = [8, 21, 25, 34, 48], iDt = [39, 40], iLink = 37;
  inWin.forEach((o, i) => {
    const r = wsM.getRow(6 + i);
    if (!o.sol_date && !o.award_date && o.fields?.derived_release) r.getCell(6).font = { italic: true, color: { argb: 'FF7C3AED' } };
    for (const c of iDate) r.getCell(c).numFmt = 'yyyy-mm-dd'; for (const c of iMoney) r.getCell(c).numFmt = '$#,##0'; for (const c of iDt) r.getCell(c).numFmt = 'yyyy-mm-dd hh:mm';
    linkCell(r.getCell(iLink), o.primary_url, o.url_kind === 'listing' ? 'Open listing' : 'Open source record');
    for (const c of [1, 5, 12, 30, 41, 44]) r.getCell(c).alignment = { wrapText: true, vertical: 'top' };
    if (/^High/.test(String(o.priority ?? ''))) r.getCell(33).font = { bold: true, color: { argb: 'FF166534' } };
  });
  widths(wsM, [44, 12, 24, 24, 60, 16, 16, 16, 24, 22, 16, 22, 16, 10, 10, 26, 26, 14, 22, 22, 16, 24, 14, 16, 16, 16, 16, 20, 26, 34, 20, 10, 14, 14, 10, 28, 18, 26, 18, 18, 40, 11, 24, 60, 12, 12, 12, 14, 10, 16, 8, 60]);

  // ───── 03 New & Changed ─────
  const wsC = wb.addWorksheet(SHEETS[2], { views: [{ state: 'frozen', ySplit: 5 }] });
  banner(wsC, `New & Changed since ${meta.baselineRunId ? `run ${meta.baselineRunId} (${meta.baselineStatus})` : 'start (no baseline — everything is new)'}`, meta, 11);
  const KIND: Record<string, string> = { new: 'New', changed: 'Changed', awarded: 'Status: awarded', cancelled: 'Status: cancelled (source-stated)', out_of_window: 'Moved outside window', no_longer_matched: 'No longer matches filters', returned: 'Returned to active' };
  const visible = changes.filter((c) => c.opp_id && (c.kind !== 'changed' || c.material));
  table(wsC, 5, ['Change Type', 'Opportunity', 'Department', 'Agency', 'Field', 'Previous Value', 'Current Value', 'Change Detected', 'Evidence', 'Material?', 'Link', 'Source IDs'],
    visible.map((c) => [KIND[c.kind] ?? c.kind, c.title, c.department, c.agency, c.field, c.old_value, c.new_value, dt(c.detected_at), c.evidence, c.material ? 'Yes' : 'No', null, (idsBy.get(c.opp_id) ?? []).join(' | ')]));
  visible.forEach((c, i) => { const r = wsC.getRow(6 + i); r.getCell(8).numFmt = 'yyyy-mm-dd hh:mm'; linkCell(r.getCell(11), c.primary_url); for (const k of [2, 9]) r.getCell(k).alignment = { wrapText: true, vertical: 'top' }; if (['cancelled', 'no_longer_matched'].includes(c.kind)) r.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AMBER } }; }); });
  if (!visible.length) { wsC.getCell('A6').value = meta.baselineRunId ? 'No new or materially changed opportunities since the previous report.' : 'No changes recorded.'; wsC.getCell('A6').font = { italic: true }; }
  widths(wsC, [28, 50, 12, 24, 18, 26, 26, 17, 54, 9, 10, 50]);
  wsC.getCell(`A${8 + Math.max(visible.length, 1)}`).value = 'Disappearance is never reported as cancellation unless the source states it. “No longer matches filters” and “unverified absence” are separate states.'; wsC.getCell(`A${8 + Math.max(visible.length, 1)}`).font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };

  // ───── 04 Recompetes ─────
  const rec = all.filter((o) => o.lifecycle === 'active' && o.review_state !== 'dismissed' && ['confirmed_recompete', 'likely_recompete', 'possible_followon', 'expiring_no_followon'].includes(o.classification));
  const wsR = wb.addWorksheet(SHEETS[3], { views: [{ state: 'frozen', ySplit: 5 }] });
  banner(wsR, 'Recompetes & incumbent intelligence', meta, 16);
  table(wsR, 5, ['Opportunity', 'Classification', 'Classification Evidence', 'Department', 'Agency', 'Incumbent', 'Incumbent UEI', 'Incumbent Contract / PIID', 'Parent Contract / Vehicle', 'Original Award Date', 'Expiration / Completion', 'Options Remaining', 'Incumbent Value', 'Value Type', 'Obligations (official)', 'Obligations as of', 'Follow-on Release (forecast)', 'Follow-on Award (forecast)', 'Follow-on Status', 'Vulnerability Indicators', 'Confidence', 'Link', 'Source IDs'],
    rec.map((o) => { const inc = o.incumbent ?? {}; return [o.title, CLASS_LABEL[o.classification], o.fields?.classEvidence ?? '', o.department, o.agency, inc.name ?? null, inc.uei ?? null, inc.piid ?? null, inc.parentVehicle ?? null, dOnly(inc.awardDate), dOnly(inc.endDate), inc.optionsRemaining ?? null, inc.value == null ? null : Number(inc.value), inc.valueType ?? null, inc.obligations == null ? null : Number(inc.obligations), inc.obligationsAsOf ?? null, dOnly(o.sol_date), dOnly(o.award_date), o.status, (o.indicators ?? []).map((x: any) => `[${x.label}] ${x.text} (${x.source}, ${x.asOf})`).join('\n'), o.confidence, null, (idsBy.get(o.id) ?? []).join(' | ')]; }));
  rec.forEach((o, i) => { const r = wsR.getRow(6 + i); for (const c of [10, 11, 17, 18]) r.getCell(c).numFmt = 'yyyy-mm-dd'; for (const c of [13, 15]) r.getCell(c).numFmt = '$#,##0'; linkCell(r.getCell(22), o.primary_url); for (const c of [1, 3, 20]) r.getCell(c).alignment = { wrapText: true, vertical: 'top' }; });
  if (!rec.length) wsR.getCell('A6').value = 'No recompete or follow-on candidates in the current window.';
  widths(wsR, [44, 26, 36, 12, 24, 26, 14, 22, 22, 14, 14, 14, 16, 26, 16, 14, 14, 14, 26, 60, 11, 10, 50]);
  wsR.getCell(`A${8 + Math.max(rec.length, 1)}`).value = 'A contract expiring does not by itself prove a recompete: “Contract expiring — no follow-on identified” rows have no solicitation, forecast or notice citing them. “Possible/Likely” rows have some textual link; “Confirmed” rows have an agency statement or a notice citing the contract number as the incumbent/current contract.'; wsR.getCell(`A${8 + Math.max(rec.length, 1)}`).font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };

  // ───── 05 18–24 month outlook ─────
  const out = inWin.filter((o) => bucket(o, today) === '18–24 months' || bucket(o, today) === 'Beyond 24 months');
  const wsO = wb.addWorksheet(SHEETS[4], { views: [{ state: 'frozen', ySplit: 5 }] });
  banner(wsO, 'Long-range outlook — releases forecast 18–24+ months out', meta, 12);
  table(wsO, 5, ['Opportunity', 'Department', 'Agency', 'Expected Release', 'Release Basis', 'Approx. Award', 'Estimated Value', 'Classification', 'Incumbent', 'Contract Expires', 'Priority', 'Confidence', 'Link'],
    out.map((o) => [o.title, o.department, o.agency, dOnly(o.sol_date ?? o.fields?.derived_release), BASIS_LABEL[o.sol_date_basis ?? 'unknown'], dOnly(o.award_date), o.value_usd == null ? null : Number(o.value_usd), CLASS_LABEL[o.classification], o.incumbent?.name ?? null, dOnly(o.incumbent?.endDate), o.priority, o.confidence, null]));
  out.forEach((o, i) => { const r = wsO.getRow(6 + i); for (const c of [4, 6, 10]) r.getCell(c).numFmt = 'yyyy-mm-dd'; r.getCell(7).numFmt = '$#,##0'; linkCell(r.getCell(13), o.primary_url); r.getCell(1).alignment = { wrapText: true, vertical: 'top' }; });
  if (!out.length) wsO.getCell('A6').value = 'No opportunities currently forecast 18 months or more out.';
  widths(wsO, [46, 12, 24, 14, 26, 14, 16, 26, 26, 14, 10, 11, 10]);

  // ───── 06 Capture priorities ─────
  const top = inWin.filter((o) => ['High', 'Medium'].includes(String(o.priority))).slice(0, 100);
  const wsP = wb.addWorksheet(SHEETS[5], { views: [{ state: 'frozen', ySplit: 5 }] });
  banner(wsP, 'Opportunity Intelligence Priority — High and Medium (company-agnostic; see docs/SCORING.md)', meta, 14);
  const compNames = ['relevance', 'value', 'timeline', 'recompete', 'maturity', 'agency'];
  table(wsP, 5, ['Rank', 'Opportunity', 'Department', 'Agency', 'Priority', 'Score', 'Relevance', 'Value', 'Timeline', 'Recompete', 'Maturity', 'Agency activity', 'Score Confidence', 'Why (score notes)', 'Unknown inputs', 'Link'],
    top.map((o, i) => { const d = o.priority_detail ?? {}; const byKey = Object.fromEntries((d.components ?? []).map((c: any) => [c.key, c])); return [i + 1, o.title, o.department, o.agency, o.priority, o.priority_score, ...compNames.map((k) => byKey[k]?.score ?? null), d.confidence ?? null, (d.components ?? []).map((c: any) => `${c.label}: ${c.note}`).join('\n'), (d.unknowns ?? []).join('\n'), null]; }));
  top.forEach((o, i) => { const r = wsP.getRow(6 + i); linkCell(r.getCell(16), o.primary_url); for (const c of [2, 14, 15]) r.getCell(c).alignment = { wrapText: true, vertical: 'top' }; });
  if (!top.length) wsP.getCell('A6').value = 'No High or Medium priority opportunities in this run.';
  widths(wsP, [6, 46, 12, 24, 10, 8, 10, 8, 9, 10, 9, 13, 12, 70, 40, 10]);

  // ───── 07 Data quality ─────
  const wsD = wb.addWorksheet(SHEETS[6]); banner(wsD, 'Data quality, coverage and caveats', meta, 6);
  let r = 5; const head = (t: string) => { wsD.getCell(r, 1).value = t; wsD.getCell(r, 1).font = { bold: true, size: 12, color: { argb: NAVY } }; r++; };
  head('Source coverage for this run');
  ['Source', 'Status', 'Detail', 'Records', 'Requests'].forEach((h, i) => { wsD.getCell(r, i + 1).value = h; }); styleHeader(wsD.getRow(r)); r++;
  for (const c of meta.coverage) { wsD.getCell(r, 1).value = c.source; wsD.getCell(r, 2).value = c.status.toUpperCase(); wsD.getCell(r, 3).value = c.detail; wsD.getCell(r, 4).value = c.fetched ?? null; wsD.getCell(r, 5).value = c.calls ?? null; wsD.getCell(r, 3).alignment = { wrapText: true, vertical: 'top' };
    if (c.status === 'failed' || c.status === 'partial') wsD.getRow(r).eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AMBER } }; }); r++; }
  r++; head('Relevance funnel by source');
  const funnel = meta.audit?.funnel ?? {}; const fkeys = ['discovered', 'out_of_scope', 'no_keyword_match', 'qualifying', 'review', 'below_min_value', 'duplicate_in_run', 'new_opportunities', 'merged_into_existing'];
  ['Source', ...fkeys.map((k) => k.replace(/_/g, ' '))].forEach((h, i) => { wsD.getCell(r, i + 1).value = h; }); styleHeader(wsD.getRow(r)); r++;
  for (const [s, f] of Object.entries<any>(funnel)) { wsD.getCell(r, 1).value = SRC_LABEL[s] ?? s; fkeys.forEach((k, i) => { wsD.getCell(r, i + 2).value = f[k] ?? 0; }); r++; }
  r++; head('Totals');
  const conflicts = inWin.reduce((a, o) => a + (o.fields?.conflicts?.length ?? 0), 0);
  for (const [k, v] of [['Opportunities in report body', inWin.length], ['In review queue (weak or partial keyword evidence; not in body)', review.length], ['Source conflicts retained', conflicts], ['Run lifecycle changes', Object.entries(meta.counts).filter(([k]) => ['awarded', 'cancelled', 'out_of_window', 'no_longer_matched', 'unverified_absent'].includes(k)).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(', ') || 'none']] as [string, any][]) { wsD.getCell(r, 1).value = k; wsD.getCell(r, 2).value = v; r++; }
  r++; head('Review queue (not in the report body)');
  ['Opportunity', 'Agency', 'Reason'].forEach((h, i) => { wsD.getCell(r, i + 1).value = h; }); styleHeader(wsD.getRow(r)); r++;
  for (const o of review.slice(0, 200)) { wsD.getCell(r, 1).value = o.title; wsD.getCell(r, 2).value = `${o.department} — ${o.agency}`; wsD.getCell(r, 3).value = o.relevance_detail?.rationale ?? ''; wsD.getCell(r, 3).alignment = { wrapText: true, vertical: 'top' }; r++; }
  r++; head('Caveats');
  for (const t of ['Dates and values marked “Agency estimate”, “Derived” or “lower bound” are estimates, not commitments. “Government-posted (verified)” means the date came from a posted notice.',
    'Contract expiration alone does not prove a recompete; the classification column explains the evidence for each row.', 'Keyword matching is deterministic and explainable; no AI model decides what appears in this report.',
    'Opportunity Intelligence Priority is a generic ranking of substance, nearness and evidence quality. It does not assess eligibility or fit for any particular company.',
    'Data comes from public sources (SAM.gov, USAspending.gov, GSA Acquisition Gateway forecast, GAO) and any files you imported. Verify at the source before relying on it. This tool is not affiliated with or endorsed by the U.S. Government.',
    'If you imported data from a licensed service, you are responsible for complying with that service\'s terms when storing or sharing this workbook.']) { wsD.getCell(r, 1).value = t; wsD.getCell(r, 1).alignment = { wrapText: true }; wsD.mergeCells(r, 1, r, 6); wsD.getRow(r).height = 32; r++; }
  widths(wsD, [46, 14, 90, 12, 12, 12, 12, 12, 12, 12]);

  // ───── 01 Executive summary (filled last) ─────
  banner(ws1, `GovCon Opportunity Intelligence — ${today}`, meta, 8); let e = 5;
  const kv = (k: string, v: any, bold = false) => { ws1.getCell(e, 1).value = k; ws1.getCell(e, 2).value = v; if (bold) ws1.getCell(e, 2).font = { bold: true }; e++; };
  const counted = inWin.reduce((a, o) => a + (o.counted_value_usd == null ? 0 : Number(o.counted_value_usd)), 0);
  const hi = inWin.filter((o) => o.priority === 'High').length, med = inWin.filter((o) => o.priority === 'Medium').length;
  const newToday = new Set(changes.filter((c) => c.kind === 'new').map((c) => c.opp_id)).size; const changedN = new Set(changes.filter((c) => c.kind === 'changed' && c.material).map((c) => c.opp_id)).size;
  ws1.getCell(e, 1).value = 'At a glance'; ws1.getCell(e, 1).font = { bold: true, size: 12, color: { argb: NAVY } }; e++;
  kv('Run status', meta.status.toUpperCase(), true); kv('Opportunities in scope', inWin.length); kv('High priority', hi); kv('Medium priority', med); kv('New since previous report', meta.baselineRunId ? newToday : `${newToday} (first report)`); kv('Materially changed', changedN);
  kv('Recompete / follow-on candidates', rec.filter((o) => o.classification !== 'expiring_no_followon').length); kv('Estimated value counted (forecast/estimate; vehicle ceilings excluded)', counted ? usd(counted) : 'n/a'); kv('Review queue (not shown in body)', review.length);
  ws1.getCell(e - 2, 2).numFmt = '@'; e++;
  ws1.getCell(e, 1).value = 'Top opportunities by priority'; ws1.getCell(e, 1).font = { bold: true, size: 12, color: { argb: NAVY } }; e++;
  ['Opportunity', 'Agency', 'Priority', 'Score', 'Release', 'Value', 'Classification', 'Basis of release date'].forEach((h, i) => { ws1.getCell(e, i + 1).value = h; }); styleHeader(ws1.getRow(e)); e++;
  for (const o of inWin.slice(0, 10)) { const rel = o.sol_date ?? o.fields?.derived_release; [o.title, `${o.department} — ${o.agency}`, o.priority, o.priority_score, dOnly(rel), o.value_usd == null ? null : Number(o.value_usd), CLASS_LABEL[o.classification], rel ? (o.sol_date ? BASIS_LABEL[o.sol_date_basis ?? 'unknown'] : 'DERIVED estimate') : 'unknown'].forEach((v, i) => { const c = ws1.getCell(e, i + 1); c.value = v as any; if (i === 4) c.numFmt = 'yyyy-mm-dd'; if (i === 5) c.numFmt = '$#,##0'; if (i === 0) c.alignment = { wrapText: true, vertical: 'top' }; }); e++; }
  e++; ws1.getCell(e, 1).value = 'By department'; ws1.getCell(e, 1).font = { bold: true, size: 12, color: { argb: NAVY } }; e++;
  ['Department', 'Opportunities', 'High', 'Medium', 'Counted value'].forEach((h, i) => { ws1.getCell(e, i + 1).value = h; }); styleHeader(ws1.getRow(e)); e++;
  const byDept = new Map<string, any[]>(); for (const o of inWin) byDept.set(o.department ?? 'Unclassified', [...(byDept.get(o.department ?? 'Unclassified') ?? []), o]);
  for (const [d, os] of [...byDept.entries()].sort((a, b) => b[1].length - a[1].length)) { [d, os.length, os.filter((o) => o.priority === 'High').length, os.filter((o) => o.priority === 'Medium').length, os.reduce((a, o) => a + (o.counted_value_usd ?? 0), 0)].forEach((v, i) => { const c = ws1.getCell(e, i + 1); c.value = v as any; if (i === 4) c.numFmt = '$#,##0'; }); e++; }
  e++; ws1.getCell(e, 1).value = 'Release timing'; ws1.getCell(e, 1).font = { bold: true, size: 12, color: { argb: NAVY } }; e++;
  ['Window', 'Opportunities'].forEach((h, i) => { ws1.getCell(e, i + 1).value = h; }); styleHeader(ws1.getRow(e)); e++;
  const bc: Record<string, number> = {}; for (const o of inWin) { const b = bucket(o, today); bc[b] = (bc[b] ?? 0) + 1; }
  for (const b of BUCKETS) if (bc[b]) { ws1.getCell(e, 1).value = b; ws1.getCell(e, 2).value = bc[b]; e++; }
  e++; ws1.getCell(e, 1).value = 'Source health'; ws1.getCell(e, 1).font = { bold: true, size: 12, color: { argb: NAVY } }; e++;
  for (const c of meta.coverage) { ws1.getCell(e, 1).value = c.source; ws1.getCell(e, 2).value = c.status.toUpperCase(); if (c.status === 'failed' || c.status === 'partial') ws1.getCell(e, 2).font = { bold: true, color: { argb: 'FFB45309' } }; e++; }
  const sig = db.all(`select title, url, published from signal order by published desc, id desc limit 5`);
  if (sig.length && !meta.demo) { e++; ws1.getCell(e, 1).value = 'Recent GAO reports (market signals)'; ws1.getCell(e, 1).font = { bold: true, size: 12, color: { argb: NAVY } }; e++; for (const s of sig) { ws1.getCell(e, 1).value = { text: s.title, hyperlink: s.url }; ws1.getCell(e, 1).font = { color: { argb: 'FF1D4ED8' }, underline: true }; ws1.getCell(e, 2).value = s.published; e++; } }
  widths(ws1, [58, 40, 12, 8, 14, 16, 30, 28]);
  ws1.getCell(`A${e + 1}`).value = 'Not affiliated with or endorsed by the U.S. Government. Estimates are not commitments; verify at the source.'; ws1.getCell(`A${e + 1}`).font = { italic: true, size: 9, color: { argb: 'FF6B7280' } };

  // ───── write atomically ─────
  const base = outDir ?? paths.reportDir; const dir = meta.dry ? join(base, 'dryrun') : base; mkdirSync(dir, { recursive: true });
  const file = join(dir, `GovCon_Pipeline_${today}${meta.demo ? '_DEMO' : ''}.xlsx`); const tmp = file + '.tmp';
  await wb.xlsx.writeFile(tmp); renameSync(tmp, file);
  const validation = await validateWorkbook(file, { masterRows: inWin.length });
  return { file, bytes: statSync(file).size, rows: inWin.length, validation };
}

export async function validateWorkbook(file: string, exp: { masterRows: number }) {
  const problems: string[] = []; const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(file);
  const names = wb.worksheets.map((w) => w.name); if (names.length !== 7 || SHEETS.some((s, i) => names[i] !== s)) problems.push(`expected 7 sheets ${SHEETS.join(' | ')}, found ${names.join(' | ')}`);
  const m = wb.getWorksheet(SHEETS[1]); let rows = 0; if (m) for (let i = 6; i <= m.rowCount; i++) if (m.getCell(i, 1).value) rows++;
  if (exp.masterRows && rows !== exp.masterRows) problems.push(`master sheet has ${rows} rows, expected ${exp.masterRows}`);
  return { ok: problems.length === 0, problems, stats: { sheets: names.length, masterRows: rows } };
}
void parseJ;
