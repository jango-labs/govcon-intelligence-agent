// Derived (estimated) RFP release date for opportunities that have no release or award date: incumbent contract expiration minus a lead time.
// It is an inference, labelled as such everywhere; it is never written to the source date columns or to forecast snapshots.
export const DERIVED_BASIS = 'derived: contract expiration − lead time (estimate)';
export function deriveRelease(o: { sol_date?: unknown; award_date?: unknown; incumbent?: { endDate?: string } | null }, leadMonths: number, minExpiry: string): string | null {
  if (!leadMonths || o.sol_date || o.award_date) return null;
  const end = o.incumbent?.endDate ? String(o.incumbent.endDate).slice(0, 10) : null; if (!end || end < minExpiry) return null;
  const d = new Date(end + 'T00:00:00Z'); d.setUTCMonth(d.getUTCMonth() - leadMonths); return d.toISOString().slice(0, 10);
}
/** GWAC / IDIQ / multiple-award contracts / BPAs / marketplaces are contract VEHICLES: their ceiling is not value to any one company until task orders are won, so it is shown for reference and never counted. */
const VEHICLE_INSTRUMENT = /gwac|idiq|indefinite[- ]delivery|multiple[- ]award|multi[- ]award|\bmac\b|\bbpa\b|blanket purchase|\bmas\b|federal supply schedule/i;
const VEHICLE_TITLE = /\b(multiple[- ]award|multi[- ]award|idiq|gwac|bpa|mac|marketplace|indefinite[- ]delivery)\b/i;
export function isVehicleCeiling(o: { instrument?: string | null; title?: string | null }): boolean { return VEHICLE_INSTRUMENT.test(o.instrument ?? '') || VEHICLE_TITLE.test(o.title ?? ''); }
export const VEHICLE_VALUE_TYPE = 'vehicle ceiling (GWAC/IDIQ/multiple-award) — reference only, not counted';
