// Opportunity Intelligence Priority: a company-agnostic, objective ranking of how substantial, near, well-evidenced and active an opportunity is.
// It never uses corporate qualifications (past performance, certifications, size status, vehicles) and never infers prime/subcontractor eligibility;
// competition type, set-aside, NAICS and vehicle are informational columns only. Company-specific qualification is intentionally NOT part of this project.
// Weights and thresholds below are the project defaults; both are configurable in config/profile.json (priority.weights / priority.thresholds). See docs/SCORING.md.
export interface PriorityWeights { relevance: number; value: number; timeline: number; recompete: number; maturity: number; agency: number }
export const DEFAULT_PRIORITY_WEIGHTS: PriorityWeights = { relevance: 30, value: 20, timeline: 15, recompete: 15, maturity: 10, agency: 10 };
export interface PriorityThresholds { high: number; medium: number; low: number }
export const DEFAULT_THRESHOLDS: PriorityThresholds = { high: 76, medium: 64, low: 52 };
export interface Component { key: keyof PriorityWeights; label: string; weight: number; score: number; note: string; known: boolean }
export interface Priority { total: number; priority: string; components: Component[]; unknowns: string[]; confidence: 'high' | 'medium' | 'low' }
export interface AgencyStat { n: number; valueUsd: number }
export interface PriorityInput {
  relevance: number; categories: number; naics?: string | null; text: string;
  valueUsd?: number | null; vehicleCeiling?: boolean; incumbentValue?: number | null;
  solDate?: string | null; solBasis?: string | null; awardDate?: string | null; fiscalYear?: number | null; today: string;
  classification: string; incumbent?: { endDate?: string; obligations?: number | null; value?: number | null; name?: string } | null;
  status?: string | null; notices?: string[]; confidence?: string | null; agencyKey: string;
}

const TECH_NAICS = /^(5415\d\d|518210|541330|541690|541715|519190)$/;
const monthsFrom = (today: string, d: string) => (new Date(d).getTime() - new Date(today).getTime()) / (30.44 * 864e5);

export function valueScore(v: number): number { return Math.round(100 * Math.max(0, Math.min(1, Math.log10(Math.max(v, 1e5) / 1e5) / Math.log10(5e8 / 1e5)))); }   // $100K → 0, $500M+ → 100 (log scale)
export function timelineScore(i: Pick<PriorityInput, 'solDate' | 'solBasis' | 'awardDate' | 'fiscalYear' | 'today'> & { incumbentEnd?: string | null }): { s: number; note: string; known: boolean } {
  const d = i.solDate ?? i.awardDate ?? (i.fiscalYear ? `${i.fiscalYear - 1}-10-01` : null);
  if (!d && i.incumbentEnd) {                                                     // no release/award date: the incumbent contract's end date still dates the follow-on (scored a little lower: it is an inference)
    const em = monthsFrom(i.today, i.incumbentEnd);
    if (em < 0) return { s: 45, note: `incumbent contract ended ${i.incumbentEnd}; no release date`, known: true };
    return { s: em <= 6 ? 80 : em <= 12 ? 68 : em <= 18 ? 56 : 46, note: `no release date; incumbent contract expires ${i.incumbentEnd} (${em.toFixed(0)} months)`, known: true };
  }
  if (!d) return { s: 35, note: 'no release or award date known', known: false };
  const m = monthsFrom(i.today, d); const gov = i.solBasis === 'government' ? 5 : 0;
  if (m < 0) return { s: 55, note: `date ${d} already passed (released or slipped)`, known: true };
  const base = m <= 6 ? 90 : m <= 12 ? 78 : m <= 18 ? 64 : 52;
  return { s: Math.min(100, base + gov), note: `${m.toFixed(0)} months out${gov ? ' (government-confirmed date)' : ''}`, known: true };
}
export function maturityScore(status: string, notices: string[]): { s: number; note: string } {
  const t = `${status} ${notices.join(' ')}`;
  if (/combined synopsis|solicitation (released|issued)|request for proposals?|\brfp\b issued|^solicitation\b|\bsolicitation –/i.test(t)) return { s: 95, note: 'solicitation released' };
  if (/presolicitation|pre-solicitation|draft rfp|draft solicitation/i.test(t)) return { s: 80, note: 'presolicitation / draft stage' };
  if (/pre-?rfp|forecast|acquisition planning|planned/i.test(t)) return { s: 60, note: 'forecast / pre-RFP stage' };
  if (/sources sought|\brfi\b|request for information|market research/i.test(t)) return { s: 45, note: 'sources sought / RFI stage' };
  return { s: 50, note: 'procurement stage not stated' };
}

export function scoreOpportunity(i: PriorityInput, w: PriorityWeights, th: PriorityThresholds, agencies: Map<string, AgencyStat>): Priority {
  const unknowns: string[] = []; const comps: Component[] = [];
  const add = (key: keyof PriorityWeights, label: string, score: number, note: string, known = true) => { comps.push({ key, label, weight: w[key], score: Math.round(score), note, known }); if (!known) unknowns.push(`${label}: ${note}`); };
  const tech = TECH_NAICS.test(i.naics ?? '') || /information technology|software|cyber|cloud|data|analytics|artificial intelligence/i.test(i.text) ? 100 : 0;
  add('relevance', 'Keyword and technical relevance', 0.65 * i.relevance + 0.2 * Math.min(1, i.categories / 3) * 100 + 0.15 * tech, `keyword score ${Math.round(i.relevance)}, ${i.categories} keyword categor${i.categories === 1 ? 'y' : 'ies'}${tech ? ', IT/technical NAICS or requirement' : ''}`);
  const v = i.valueUsd ?? null, proxy = v == null && i.incumbentValue ? i.incumbentValue : null;
  if (i.vehicleCeiling) add('value', 'Opportunity value', 50, 'contract-vehicle ceiling (GWAC/IDIQ/multiple-award): not counted as value; neutral score', true);
  else add('value', 'Opportunity value', v != null ? valueScore(v) : proxy ? valueScore(proxy) : 50, v != null ? 'estimated opportunity value (a forecast, not an obligation)' : proxy ? 'no opportunity value; the incumbent contract value is used as a proxy' : 'value not estimated; neutral score', v != null || !!proxy);
  const t = timelineScore({ ...i, incumbentEnd: i.incumbent?.endDate ?? null }); add('timeline', 'Procurement timeline', t.s, t.note, t.known);
  const inc = i.incumbent ?? {}; const cls = i.classification;
  let rc = cls === 'confirmed_recompete' ? 88 : cls === 'likely_recompete' ? 70 : cls === 'possible_followon' ? 55 : cls === 'new_requirement' ? 60 : cls === 'expiring_no_followon' ? 40 : 40; const rn: string[] = [cls.replace(/_/g, ' ')];
  if (inc.name) { rc += 4; rn.push('incumbent identified'); } if (inc.endDate) { rc += 4; rn.push(`contract ends ${inc.endDate}`); }
  if (inc.value && inc.obligations != null && inc.obligations / inc.value >= 0.9) { rc += 4; rn.push('ceiling ≥ 90% obligated'); }
  add('recompete', 'Recompete and incumbent intelligence', Math.min(100, rc), rn.join('; '), cls !== 'unknown');
  const mat = maturityScore(i.status ?? '', i.notices ?? []); const conf = i.confidence === 'High' ? 100 : i.confidence === 'Medium' ? 70 : 40;
  add('maturity', 'Procurement maturity and data confidence', 0.5 * mat.s + 0.5 * conf, `${mat.note}; data confidence ${i.confidence ?? 'unknown'}`);
  const all = [...agencies.values()]; const me = agencies.get(i.agencyKey);
  if (me && all.length > 1) {
    const rankN = all.filter((a) => a.n <= me.n).length / all.length, rankV = all.filter((a) => a.valueUsd <= me.valueUsd).length / all.length;
    add('agency', 'Agency procurement activity', 100 * (0.6 * rankN + 0.4 * rankV), `${me.n} active opportunit${me.n === 1 ? 'y' : 'ies'} and ${me.valueUsd ? '$' + Math.round(me.valueUsd / 1e6).toLocaleString('en-US') + 'M' : 'no'} estimated value at this agency in the pipeline`);
  } else add('agency', 'Agency procurement activity', 50, 'agency activity not comparable', false);
  const wsum = comps.reduce((a, c) => a + c.weight, 0) || 1; const total = Math.round(comps.reduce((a, c) => a + c.score * c.weight, 0) / wsum);
  const known = comps.filter((c) => c.known).reduce((a, c) => a + c.weight, 0) / wsum;
  return { total, priority: total >= th.high ? 'High' : total >= th.medium ? 'Medium' : total >= th.low ? 'Low' : 'Watch', components: comps, unknowns, confidence: known >= 0.85 ? 'high' : known >= 0.6 ? 'medium' : 'low' };
}
