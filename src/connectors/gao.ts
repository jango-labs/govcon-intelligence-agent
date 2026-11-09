// GAO public reports RSS (official feed). Stored as "market signals", not opportunities. The GAO bid-protest docket search is NOT scraped.
import type { Db } from '../db.ts';
import { fetchData } from '../util/http.ts';

const FEED = () => process.env.GOVCON_GAO_URL ?? 'https://www.gao.gov/rss/reports.xml';
const RELEVANT = /\b(acquisition|procurement|contract(s|ing|or)?|IT\b|information technology|cyber|artificial intelligence|\bAI\b|cloud|moderni[sz]ation|software|data|telecommunications|legacy|portfolio)\b/i;
export interface RssItem { title: string; link: string; description: string; pubDate: string | null }
export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const g = (tag: string) => (new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(m[1])?.[1] ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/\s+/g, ' ').trim();
    items.push({ title: g('title'), link: g('link'), description: g('description'), pubDate: g('pubDate') || null });
  }
  return items;
}
export async function pullGao(db: Db, o: { xml?: string } = {}): Promise<{ fetched: number; created: number; skipped: number }> {
  const xml = o.xml ?? (await fetchData<string>(FEED(), { as: 'text', timeoutMs: 30000, retries: 2 })).data;
  const items = parseRss(xml); let created = 0, skipped = 0;
  for (const it of items) {
    if (!it.link || !/^https:\/\/(www\.)?gao\.gov\//.test(it.link) || !RELEVANT.test(`${it.title} ${it.description.slice(0, 600)}`)) { skipped++; continue; }
    const day = it.pubDate && !Number.isNaN(new Date(it.pubDate).getTime()) ? new Date(it.pubDate).toISOString().slice(0, 10) : null;
    const r = db.run(`insert into signal(source,title,url,published,summary) values ('gao_reports',?,?,?,?) on conflict(url) do nothing`, [it.title, it.link, day, it.description.slice(0, 500)]);
    if (Number(r.changes)) created++; else skipped++;
  }
  return { fetched: items.length, created, skipped };
}
