// Deterministic recompete evidence: a notice/forecast text that cites a contract number (PIID) in the context of an incumbent, current,
// existing or predecessor contract. The cited PIID is looked up in USAspending, so the incumbent fields come from official award data.
import { Db, J, parseJ } from '../db.ts';
import { lookupPiid, toIncumbent } from '../connectors/usaspending.ts';
import { CLASS_ORDER } from './store.ts';

const TOKEN = /\b(?=[0-9A-Z-]{12,24}\b)(?=[0-9A-Z-]*\d)(?=[0-9A-Z-]*[A-Z])[0-9A-Z]{4,6}\d{2}[A-Z]\d{4,5}[0-9A-Z-]{0,6}\b/g;
const CONTEXT = /\b(incumbent|current(?:ly)?|existing|predecessor|follow[- ]?on|re-?compete|bridge|extension|supports?|replaces?|successor)\b/i;
export function citedPiids(text: string): { piid: string; context: boolean }[] {
  const out = new Map<string, boolean>(); let m: RegExpExecArray | null; TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text))) { const near = text.slice(Math.max(0, m.index - 90), m.index + m[0].length + 90); const k = m[0].replace(/-/g, ''); out.set(k, (out.get(k) ?? false) || CONTEXT.test(near)); }
  return [...out.entries()].map(([piid, context]) => ({ piid, context }));
}
export async function linkPredecessors(db: Db, today: string, cap = 40): Promise<{ checked: number; linked: number; confirmed: number }> {
  const rows = db.all(`select id, title, description, fields, incumbent, classification, sources from opp where lifecycle='active' order by first_discovered desc limit 3000`);
  let checked = 0, linked = 0, confirmed = 0;
  for (const o of rows) {
    if (parseJ<string[]>(o.sources, []).every((s) => s === 'usaspending_award')) continue;       // an award record citing itself proves nothing
    const f = parseJ<any>(o.fields, {}); const inc0 = parseJ<any>(o.incumbent, {}); const text = `${o.title} ${o.description ?? ''} ${f.other ?? ''}`; const seen: string[] = f.checked_piids ?? [];
    for (const { piid, context } of citedPiids(text)) {
      if (seen.includes(piid) || inc0.piid === piid) continue;
      if (checked >= cap) return { checked, linked, confirmed };
      checked++; seen.push(piid);
      let found: Awaited<ReturnType<typeof lookupPiid>> = null;
      try { found = await lookupPiid(piid, today, db); } catch { found = null; }
      f.checked_piids = seen; db.run(`update opp set fields=? where id=?`, [J(f), o.id]);
      if (!found) continue;
      linked++;
      const inc = toIncumbent(found.hit, found.detail); const cls = context ? 'confirmed_recompete' : 'likely_recompete';
      if (CLASS_ORDER.indexOf(cls) > CLASS_ORDER.indexOf(o.classification) || !inc0.name) {
        f.classEvidence = `text cites contract ${piid}${context ? ' as the incumbent/current/predecessor contract' : ' (context unclear)'}; incumbent details are from USAspending.gov`;
        db.run(`update opp set incumbent=?, classification=case when ? then ? else classification end, fields=? where id=?`, [J({ ...inc0, ...inc }), CLASS_ORDER.indexOf(cls) > CLASS_ORDER.indexOf(o.classification) ? 1 : 0, cls, J(f), o.id]);
        if (context) confirmed++;
      }
      // the expiring-award record that this notice cites now has follow-on evidence
      const local = db.get(`select id, fields from opp where piid=? and id<>? limit 1`, [piid, o.id]);
      if (local) { const lf = parseJ<any>(local.fields, {}); lf.classEvidence = `opportunity #${o.id} (“${String(o.title).slice(0, 70)}”) cites this contract${context ? ' as incumbent/current/predecessor' : ''}`; db.run(`update opp set classification=case when classification='expiring_no_followon' then ? else classification end, fields=? where id=?`, [context ? 'likely_recompete' : 'possible_followon', J(lf), local.id]); }
    }
  }
  return { checked, linked, confirmed };
}
