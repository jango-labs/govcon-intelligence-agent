import { describe, it, expect } from 'vitest';
import { compile, matchKeywords, toKeywords, isStrong } from '../src/keywords.ts';
import { normalizeOrg, inScope } from '../src/scope.ts';

const c = compile(toKeywords([{ term: 'artificial intelligence', synonyms: ['AI', 'machine learning'], exclusions: ['air intelligence'] }, { term: 'cloud migration', category: 'Cloud' }, { term: 'DevSecOps' }]));
describe('keyword matching', () => {
  it('matches phrases, plurals, hyphen/space variants and synonyms', () => {
    expect(matchKeywords({ title: 'Cloud-Migration services' }, c).matched).toContain('cloud migration');
    expect(matchKeywords({ title: 'Machine Learning platform' }, c).matched).toContain('artificial intelligence');
    expect(matchKeywords({ title: 'Cloud migrations support' }, c).tier).not.toBe('none');
  });
  it('treats acronyms case-sensitively and ignores ALL-CAPS text', () => {
    expect(matchKeywords({ title: 'Said the contractor' }, c).tier).toBe('none');
    expect(matchKeywords({ title: 'AI support for analysts' }, c).matched).toContain('artificial intelligence');
    expect(matchKeywords({ title: 'AI SUPPLY BOOTS AND UNIFORMS' }, c).tier).toBe('none');
  });
  it('applies exclusions near a hit', () => { expect(matchKeywords({ title: 'Air intelligence AI squadron' }, c).tier).toBe('none'); });
  it('title hits are strong, a single description mention is weak', () => {
    expect(isStrong(matchKeywords({ title: 'DevSecOps platform' }, c))).toBe(true);
    expect(isStrong(matchKeywords({ title: 'Support services', description: 'includes DevSecOps' }, c))).toBe(false);
  });
});
describe('organisation scope', () => {
  it('normalises departments and components', () => {
    expect(normalizeOrg('HOMELAND SECURITY, DEPARTMENT OF', 'U.S. CUSTOMS AND BORDER PROTECTION')).toMatchObject({ department: 'DHS', agency: 'CBP' });
    expect(normalizeOrg('DEPT OF DEFENSE', 'DEPT OF THE NAVY')).toMatchObject({ department: 'DoD', agency: 'Navy' });
    expect(normalizeOrg('Department of War', 'Department of the Army')).toMatchObject({ department: 'DoD', agency: 'Army' });
    expect(normalizeOrg('Department of Energy')).toMatchObject({ department: 'DOE' });
    expect(normalizeOrg('Some Unknown Org').department).toBeNull();
  });
  it('honours configured departments and ALL', () => {
    const o = normalizeOrg('Department of Veterans Affairs'); expect(inScope(o, ['VA'])).toBe(true); expect(inScope(o, ['DHS'])).toBe(false); expect(inScope(o, ['ALL'])).toBe(true);
  });
});
