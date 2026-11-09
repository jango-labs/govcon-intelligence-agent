// Keyword matching with explainable results. No model is involved in deciding a match.
//  - Exact phrase (hyphen/space/slash tolerant), configured synonyms, acronym-aware (short all-caps tokens need uppercase and word boundaries).
//  - Exclusion phrases suppress a hit when found next to it.
import type { KeywordDef } from './config.ts';

export interface Keyword { term: string; category: string; synonyms: string[]; exclusions: string[]; weight: number }
export const toKeywords = (defs: KeywordDef[]): Keyword[] => defs.filter((d) => d.enabled !== false).map((d) => ({ term: d.term, category: d.category ?? 'General', synonyms: d.synonyms ?? [], exclusions: d.exclusions ?? [], weight: d.weight ?? 1 }));

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function phraseRegex(p: string): RegExp {
  // synonyms may contain simple regex fragments such as moderni[sz]ation; otherwise escape. Hyphen/space/slash are interchangeable.
  const isRe = /\[[^\]]+\]/.test(p);
  const body = (isRe ? p : esc(p)).replace(/(\\-|-|\s+|\\\/|\/)/g, '[\\s\\-/]*');
  const short = p.replace(/[^A-Za-z]/g, '').length <= 3 && /^[A-Z0-9./&\- ]+$/.test(p);   // acronym: AI, ML, AWS, A.I.
  const infl = short ? body : body.replace(/iz(ation|e|ing|ed)/gi, 'i[sz]$1') + (isRe ? '' : '(?:s|es)?');   // US/UK spelling and an optional plural
  return new RegExp(`(?<![A-Za-z0-9])${infl}(?![A-Za-z0-9])`, short ? '' : 'i');          // acronyms are case-sensitive: "AI" must not match "said"
}
export interface KeywordHit { term: string; category: string; via: 'phrase' | 'synonym'; where: 'title' | 'description' | 'other'; evidence: string; weight: number }
export interface MatchResult { suppressedAcronym?: boolean; hits: KeywordHit[]; matched: string[]; category: string | null; score: number; rationale: string; tier: 'qualifying' | 'review' | 'none' }

export function compile(kws: Keyword[]) {
  return kws.map((k) => ({ k, phrase: phraseRegex(k.term), syn: k.synonyms.map(phraseRegex), excl: k.exclusions.map((e) => new RegExp(esc(e), 'i')) }));
}
export type Compiled = ReturnType<typeof compile>;
function excerpt(text: string, idx: number, len: number) {
  const a = Math.max(0, idx - 60), b = Math.min(text.length, idx + len + 60);
  return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ').trim() + (b < text.length ? '…' : '');
}
/** Match a record's fields against the dictionary. Title hits count double; description hits once; diminishing returns. */
export function matchKeywords(fields: { title?: string | null; description?: string | null; other?: string | null }, compiled: Compiled, threshold = 25): MatchResult {
  const parts: [KeywordHit['where'], string][] = [['title', fields.title ?? ''], ['description', fields.description ?? ''], ['other', fields.other ?? '']];
  const hits: KeywordHit[] = []; let suppressedAcronym = false;
  for (const c of compiled) {
    let best: KeywordHit | null = null;
    for (const [where, text] of parts) {
      if (!text) continue;
      const upper = (text.match(/[A-Z]/g)?.length ?? 0) / Math.max(1, text.match(/[A-Za-z]/g)?.length ?? 1);
      const tryRe = (re: RegExp, via: 'phrase' | 'synonym') => {
        const acronym = !re.flags.includes('i');
        if (acronym && upper > 0.7) { if (re.test(text)) suppressedAcronym = true; return; }                   // ALL-CAPS text (e.g. SAM supply titles): "AI" cannot be told apart from an abbreviation
        const m = re.exec(text); if (!m) return;
        const near = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40);
        if (c.excl.some((x) => x.test(near))) return;
        const h: KeywordHit = { term: c.k.term, category: c.k.category, via, where, evidence: excerpt(text, m.index, m[0].length), weight: c.k.weight * (via === 'synonym' ? 0.9 : 1) * (acronym ? 0.7 : 1) * (where === 'title' ? 2 : where === 'description' ? 1 : 0.5) };
        if (!best || h.weight > best.weight) best = h;
      };
      tryRe(c.phrase, 'phrase'); for (const s of c.syn) tryRe(s, 'synonym');
    }
    if (best) hits.push(best);
  }
  const sum = hits.reduce((a, h) => a + h.weight, 0);
  const score = Math.round(100 * (1 - Math.exp(-sum / 3)));
  const byCat = new Map<string, number>(); for (const h of hits) byCat.set(h.category, (byCat.get(h.category) ?? 0) + h.weight);
  const category = [...byCat.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const tier: MatchResult['tier'] = !hits.length ? 'none' : score >= threshold ? 'qualifying' : 'review';
  const rationale = hits.length ? `${hits.length} keyword${hits.length > 1 ? 's' : ''}: ` + hits.map((h) => `${h.term} (${h.where}${h.via === 'synonym' ? ', synonym' : ''})`).join('; ') : 'No configured keyword found in title or description';
  return { suppressedAcronym, hits, matched: hits.map((h) => h.term), category, score, rationale, tier };
}
/** Strong evidence = a keyword in the TITLE, or two or more DISTINCT keywords, or a high score. A lone description-only mention is weak. */
export function isStrong(m: MatchResult): boolean { return m.hits.some((h) => h.where === 'title') || new Set(m.hits.map((h) => h.term)).size >= 2 || m.score >= 40; }
