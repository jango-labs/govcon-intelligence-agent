import { describe, it, expect } from 'vitest';
import { scoreOpportunity, valueScore, timelineScore, maturityScore, DEFAULT_PRIORITY_WEIGHTS, DEFAULT_THRESHOLDS } from '../src/priority.ts';

const base = { relevance: 80, categories: 3, naics: '541512', text: 'cloud', today: '2026-11-09', classification: 'new_requirement', agencyKey: 'A|B' };
describe('Opportunity Intelligence Priority (production weights preserved)', () => {
  it('keeps the six-factor weights and thresholds', () => {
    expect(DEFAULT_PRIORITY_WEIGHTS).toEqual({ relevance: 30, value: 20, timeline: 15, recompete: 15, maturity: 10, agency: 10 });
    expect(DEFAULT_THRESHOLDS).toEqual({ high: 76, medium: 64, low: 52 });
  });
  it('value is log-scaled $100K→0 … $500M→100', () => { expect(valueScore(1e5)).toBe(0); expect(valueScore(5e8)).toBe(100); expect(valueScore(1e9)).toBe(100); expect(valueScore(2.2e7)).toBeGreaterThan(50); });
  it('timeline rewards near releases and marks unknowns', () => {
    expect(timelineScore({ today: '2026-11-09', solDate: '2027-02-01', solBasis: 'government' }).s).toBe(95);
    expect(timelineScore({ today: '2026-11-09', solDate: '2027-02-01' }).s).toBe(90);
    expect(timelineScore({ today: '2026-11-09' }).known).toBe(false);
  });
  it('maturity reads procurement stage', () => { expect(maturityScore('Combined Synopsis/Solicitation', []).s).toBe(95); expect(maturityScore('Presolicitation', []).s).toBe(80); expect(maturityScore('', []).s).toBe(50); });
  it('maps totals to High/Medium/Low/Watch and reports unknown inputs', () => {
    const ag = new Map([['A|B', { n: 5, valueUsd: 1e7 }], ['C|D', { n: 1, valueUsd: 0 }]]);
    const hi = scoreOpportunity({ ...base, valueUsd: 4e8, solDate: '2027-01-15', solBasis: 'government', classification: 'confirmed_recompete', incumbent: { name: 'X', endDate: '2027-03-01' }, status: 'Combined Synopsis/Solicitation', confidence: 'High' }, DEFAULT_PRIORITY_WEIGHTS, DEFAULT_THRESHOLDS, ag);
    expect(hi.priority).toBe('High'); expect(hi.total).toBeGreaterThanOrEqual(76);
    const lo = scoreOpportunity({ ...base, relevance: 10, categories: 0, naics: '999999', valueUsd: null, classification: 'unknown', confidence: 'Low' }, DEFAULT_PRIORITY_WEIGHTS, DEFAULT_THRESHOLDS, new Map());
    expect(['Low', 'Watch']).toContain(lo.priority); expect(lo.unknowns.length).toBeGreaterThan(0); expect(lo.confidence).toBe('low');
  });
  it('is company-agnostic: contract-vehicle ceilings are neutral, not counted', () => {
    const r = scoreOpportunity({ ...base, valueUsd: 9e9, vehicleCeiling: true, solDate: '2027-02-01' }, DEFAULT_PRIORITY_WEIGHTS, DEFAULT_THRESHOLDS, new Map());
    expect(r.components.find((c) => c.key === 'value')!.score).toBe(50);
  });
  it('weights are normalised, so custom weights still produce 0–100', () => {
    const r = scoreOpportunity({ ...base, valueUsd: 5e7 }, { relevance: 3, value: 2, timeline: 1.5, recompete: 1.5, maturity: 1, agency: 1 }, DEFAULT_THRESHOLDS, new Map());
    expect(r.total).toBeGreaterThan(0); expect(r.total).toBeLessThanOrEqual(100);
  });
});
