// Small helpers shared by connectors.
import type { Candidate } from '../types.ts';

export const stripHtml = (s: unknown) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
export const toDate = (v: unknown): string | null => { const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v ?? '')); return m ? m[1] : null; };
export function normSol(s?: string | null): string | null {
  const x = String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return x.length >= 6 && !/^(TBD|NONE|NA|N\/A|UNKNOWN|0+)$/.test(x) ? x : null;
}
/** "$2M to $5M" → 2,000,000 (the lower bound: a conservative figure, always labelled as such); "Over $100M" → 100,000,000. */
export function rangeLowerBound(label: unknown): number | null {
  const m = /\$\s*([\d.,]+)\s*([KMB])?/i.exec(String(label ?? '')); if (!m) return null; const n = Number(m[1].replace(/,/g, '')); if (!Number.isFinite(n)) return null;
  return Math.round(n * ({ K: 1e3, M: 1e6, B: 1e9 } as Record<string, number>)[(m[2] ?? '').toUpperCase()] || n);
}
const RECOMPETE_RE = /\b(re-?compete|recompetition|follow[- ]?on|successor to|incumbent|current contract (expires|ends)|replaces? (the )?(existing|current)|bridge (contract|extension))\b/i;
const NEW_RE = /\bnew (requirement|start|program|effort|capability)\b|\bno incumbent\b/i;
export function classHint(text: string): Pick<Candidate, 'classHint' | 'classEvidence'> {
  const m = RECOMPETE_RE.exec(text); if (m) return { classHint: 'likely_recompete', classEvidence: `source text mentions "${m[0]}"` };
  const n = NEW_RE.exec(text); if (n) return { classHint: 'new_requirement', classEvidence: `source text says "${n[0]}"` };
  return { classHint: 'unknown' };
}
export const INSTR: [RegExp, string][] = [[/task|delivery order|\bTO\b|\bDO\b/i, 'Task Order'], [/gwac/i, 'GWAC'], [/\bidiq\b|indefinite/i, 'IDIQ'], [/\bbpa\b|blanket purchase/i, 'BPA'], [/\bmac\b|multiple award/i, 'Multiple-Award Contract'], [/\bota\b|other transaction/i, 'OTA'], [/definitive|standalone|stand-alone/i, 'Standalone contract']];
export const instrumentOf = (s?: string | null) => { const t = String(s ?? ''); return t ? INSTR.find(([re]) => re.test(t))?.[1] ?? t : undefined; };
