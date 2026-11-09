// Re-score every active opportunity (timing depends on today; keywords on the merged text) and derive gaps, confidence and indicators.
import { Db, J, parseJ } from '../db.ts';
import type { Profile } from '../config.ts';
import { matchKeywords, isStrong, type Compiled } from '../keywords.ts';
import { scoreOpportunity, type AgencyStat } from '../priority.ts';
import { deriveRelease, isVehicleCeiling } from '../derive.ts';
import { vulnerabilityIndicators } from '../indicators.ts';

const textOf = (o: any, f: any) => [o.title, o.description, f?.other].filter(Boolean).join(' \n ');

export function confidenceOf(o: any): string {
  const src: string[] = o.sources ?? []; const gov = o.sol_date_basis === 'government' || o.sol_date_basis === 'government_estimate';
  if (src.includes('sam_notice')) return src.length >= 2 && (gov || (o.fields?.conflicts?.length ?? 0) === 0) ? 'High' : 'Medium';
  if (src.length >= 2 && gov) return 'High';
  if (src.includes('gsa_forecast') || src.includes('sample')) return gov || o.sol_date ? 'Medium' : 'Low';
  return 'Low';
}
export function gapsFor(o: any): string[] {
  const g: string[] = [];
  if (!o.sol_date && o.fields?.derived_release) g.push(`Release date is DERIVED (${o.fields.derived_release} = incumbent contract expiration − ${o.fields.derived_lead_months ?? 6} months); not a government date`);
  else if (!o.sol_date) g.push(o.fields?.fiscalYear ? `Only fiscal year known (FY${o.fields.fiscalYear}); release month not published` : 'Solicitation release date unknown');
  else if (o.sol_date_basis === 'government_estimate') g.push('Release date is an agency ESTIMATE (forecast), not a posted solicitation');
  else if (o.sol_date_basis === 'imported') g.push('Release date comes from an imported file and has not been verified');
  if (!o.award_date) g.push('Approximate award date unknown');
  if (o.value_kind === 'vehicle_ceiling') g.push('Value is a contract-vehicle ceiling (GWAC/IDIQ/multiple-award): shown for reference, not counted in pipeline totals');
  else if (o.value_usd == null) g.push('Estimated opportunity value not available');
  else if (/lower bound/i.test(o.value_type ?? '')) g.push('Value is the lower bound of an agency dollar range (estimate)');
  if (!o.set_aside) g.push('Competition type / set-aside not stated (informational)');
  if (o.classification === 'unknown') g.push('New vs recompete not determinable from available sources');
  if (['possible_followon', 'likely_recompete'].includes(o.classification) && !o.incumbent?.name) g.push('Recompete suspected but incumbent not identified');
  if (o.classification === 'expiring_no_followon') g.push('Contract approaching expiration; no solicitation, forecast or notice citing it was found (expiration alone does not prove a recompete)');
  if (o.incumbent?.name && o.incumbent.obligations == null) g.push('Incumbent obligations not retrieved from an official source');
  if ((o.fields?.conflicts?.length ?? 0) > 0) g.push(`${o.fields.conflicts.length} source conflict(s) retained — see Data Quality`);
  if (o.url_kind === 'listing') g.push('Link is the source\'s listing page (the source offers no per-record link); search it for the title or ID');
  if (!(o.sources ?? []).includes('sam_notice') && (o.sources ?? []).some((s: string) => s !== 'usaspending_award')) g.push('No SAM.gov notice found for this opportunity yet (absence does not prove a forecast is false)');
  return g;
}

export function rescoreAll(db: Db, today: string, compiled: Compiled, profile: Profile): number {
  const rows = db.all(`select * from opp where lifecycle in ('active','out_of_window','awarded') order by id`);
  const pw = profile.priority.weights, pth = profile.priority.thresholds; const threshold = profile.relevance.threshold;
  const agencies = new Map<string, AgencyStat>();
  for (const o of rows) { if (o.lifecycle !== 'active' || o.review_state === 'review' || o.review_state === 'dismissed') continue; const k = `${o.department}|${o.agency}`; const a = agencies.get(k) ?? { n: 0, valueUsd: 0 }; a.n++; a.valueUsd += o.value_usd == null ? 0 : Number(o.value_usd); agencies.set(k, a); }
  const lead = profile.derive.rfpLeadMonths, minExp = profile.derive.minExpiry ?? today; const strongOnly = profile.relevance.evidence === 'strong';
  const vehicles = profile.filters.vehicles.map((v) => v.toLowerCase());
  let n = 0;
  db.tx(() => {
    for (const r of rows) {
      const o: any = { ...r, incumbent: parseJ<any>(r.incumbent, {}), fields: parseJ<any>(r.fields, {}), sources: parseJ<string[]>(r.sources, []) };
      const m = matchKeywords({ title: o.title, description: o.description, other: o.fields?.other }, compiled, threshold);
      const weakEv = m.tier === 'qualifying' && strongOnly && !isStrong(m);
      if (o.review_state !== 'dismissed') {
        const target = weakEv || m.tier === 'review' ? 'review' : m.tier === 'qualifying' ? 'none' : null;
        if (target && target !== o.review_state && !o.fields.naics_review) db.run(`update opp set review_state=? where id=?`, [target, o.id]);
      }
      const relevance = m.score; const rationale = weakEv ? `${m.rationale}; a single description-only mention is weak evidence — kept for review` : m.rationale;
      const cats = new Set(m.hits.map((h) => h.category)).size;
      const derived = deriveRelease(o, lead, minExp); const vehicle = isVehicleCeiling(o); const counted = vehicle || o.value_usd == null ? null : Number(o.value_usd);
      const haystack = `${o.title} ${o.description ?? ''} ${o.vehicle ?? ''} ${o.fields?.other ?? ''}`.toLowerCase();
      const vm = profile.filters.vehicles.filter((v, i) => haystack.includes(vehicles[i]));
      const pr = scoreOpportunity({ relevance, categories: cats, naics: o.naics, text: textOf(o, o.fields), valueUsd: counted, vehicleCeiling: vehicle, incumbentValue: vehicle || o.incumbent?.value == null ? null : Number(o.incumbent.value),
        solDate: o.sol_date ?? derived, solBasis: o.sol_date_basis, awardDate: o.award_date ?? null, fiscalYear: o.fields?.fiscalYear ?? null, today, classification: o.classification, incumbent: o.incumbent, status: o.status,
        notices: o.fields?.notices ?? [], confidence: confidenceOf(o), agencyKey: `${o.department}|${o.agency}` }, pw, pth, agencies);
      const f = { ...o.fields, vehicle_match: vm }; if (derived) { f.derived_release = derived; f.derived_lead_months = lead; } else delete f.derived_release;
      const gaps = gapsFor({ ...o, value_kind: vehicle ? 'vehicle_ceiling' : 'procurement', fields: f }); const ind = vulnerabilityIndicators(o, today);
      db.run(`update opp set matched_keywords=?, keyword_category=?, relevance=?, relevance_detail=?, priority=?, priority_score=?, priority_detail=?, gaps=?, indicators=?, confidence=?, value_kind=?, counted_value_usd=?, fields=? where id=?`,
        [J(m.matched), m.category, relevance, J({ hits: m.hits, rationale, tier: m.tier }), pr.priority, pr.total, J(pr), J(gaps), J(ind), confidenceOf(o), vehicle ? 'vehicle_ceiling' : 'procurement', counted, J(f), o.id]);
      n++;
    }
  });
  return n;
}
