// Incumbent vulnerability / capture-research indicators. Evidence-based only: each indicator is labelled
// verified fact (source text/data), hypothesis for capture research, or insufficient evidence — with source and timestamp.
// No contractor is scored negatively from rumour or from absence of data; CPARS is never assumed to be available.
export type IndicatorLabel = 'verified fact' | 'hypothesis' | 'insufficient evidence';
export interface Indicator { label: IndicatorLabel; kind: string; text: string; source: string; asOf: string }
const fmt = (n: unknown) => '$' + Math.round(Number(n)).toLocaleString('en-US');

export function vulnerabilityIndicators(o: any, today: string): Indicator[] {
  const out: Indicator[] = []; const inc = o.incumbent ?? {}; const text = `${o.title ?? ''} ${o.description ?? ''} ${o.fields?.other ?? ''}`;
  const srcOf = (s?: string) => s ?? 'record';
  const ex = /\b(bridge (contract|award|period)|short[- ]term extension|sole[- ]source (extension|bridge)|extension of (the )?(existing|current) (contract|task order))\b/i.exec(text);
  if (ex) out.push({ label: 'verified fact', kind: 'bridge/extension language', text: `Source text mentions "${ex[0]}"`, source: (o.sources ?? []).join(', ') || 'record', asOf: today });
  if (inc.name && inc.endDate) {
    if (inc.endDate < today) out.push({ label: 'verified fact', kind: 'period of performance ended', text: `Incumbent period of performance end date ${inc.endDate} has passed per ${srcOf(inc.source)}; work may continue under an extension or bridge (not confirmed)`, source: srcOf(inc.source), asOf: today });
    else if ((new Date(inc.endDate).getTime() - new Date(today).getTime()) / 864e5 <= 180 && !(o.sources ?? []).some((s: string) => s === 'sam_notice'))
      out.push({ label: 'hypothesis', kind: 'follow-on gap', text: `Contract ends ${inc.endDate} and no solicitation notice was found on SAM.gov; an extension or bridge may be needed (hypothesis for capture research)`, source: srcOf(inc.source), asOf: today });
  }
  if (inc.value && inc.obligations != null && Number(inc.value) > 0) {
    const pct = Math.round((Number(inc.obligations) / Number(inc.value)) * 100);
    if (pct >= 90) out.push({ label: 'verified fact', kind: 'ceiling nearly exhausted', text: `${pct}% of total potential value obligated (${fmt(inc.obligations)} of ${fmt(inc.value)}) as of ${inc.obligationsAsOf ?? 'retrieval'}`, source: String(inc.obligationsSource ?? inc.source ?? 'USAspending'), asOf: inc.obligationsAsOf ?? today });
  }
  if ((o.fields?.conflicts ?? []).some((c: any) => c.field === 'incumbent')) out.push({ label: 'hypothesis', kind: 'incumbent transition?', text: 'Sources disagree on the incumbent contract; possible incumbent transition or data mismatch — verify before relying on it', source: 'cross-source comparison', asOf: today });
  if (!out.length) out.push({ label: 'insufficient evidence', kind: 'none', text: 'No verifiable indicators from available sources (CPARS and other restricted evaluations were not accessed)', source: 'n/a', asOf: today });
  return out;
}
