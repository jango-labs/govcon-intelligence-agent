// Optional AI layer. Default provider is "none": nothing leaves your computer and everything works.
// Models never supply facts: they may (1) translate a question into a validated filter and (2) rephrase text the deterministic engine already produced,
// and a rephrasing is rejected if it introduces any number or proper-noun-like token that is not in the source text ("no new facts" guard).
// Cloud providers receive only the question and the few result rows needed; paid usage is capped and ledgered.
import { Db } from '../db.ts';
import type { Profile } from '../config.ts';
import { getSecret } from '../secrets.ts';
import { USER_AGENT } from '../util/http.ts';
import { redactText } from '../util/log.ts';

export interface LlmResult { text: string; inputTokens: number; outputTokens: number; model: string; costUsd: number }
export interface LlmProvider { name: string; external: boolean; complete(system: string, user: string, o?: { maxTokens?: number }): Promise<LlmResult> }
// USD per million tokens (input, output). Indicative only: verify against the provider's current price list before relying on the cap.
const PRICES: Record<string, [number, number]> = { 'claude-haiku-5-5': [1, 5], 'claude-sonnet-5-5': [3, 15], 'claude-opus-5-5': [15, 75], 'gpt-4o-mini': [0.15, 0.6], 'gpt-4o': [2.5, 10] };

export const monthSpendUsd = (db: Db) => Number(db.get(`select coalesce(sum(est_cost_usd),0) s from llm_usage where at >= ?`, [new Date().toISOString().slice(0, 7) + '-01'])!.s);
async function post(url: string, headers: Record<string, string>, body: unknown, ms: number) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT, ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);   // response bodies are not echoed: they can contain request fragments
  return r.json() as Promise<any>;
}
export async function getProvider(db: Db, profile: Profile): Promise<LlmProvider | null> {
  const kind = profile.llm.provider; const model = profile.llm.model; const cap = profile.llm.monthlyCapUsd;
  const guard = () => { if (cap <= 0 || monthSpendUsd(db) >= cap) throw new Error('monthly LLM cost cap reached or not set (llm.monthlyCapUsd)'); };
  if (kind === 'ollama') {
    const base = (process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    return { name: 'ollama', external: !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(base), async complete(system, user, o) {
      const d = await post(`${base}/api/chat`, {}, { model: model || 'llama3.1', stream: false, options: { temperature: 0.1, num_predict: o?.maxTokens ?? 600 }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }, 120000);
      return { text: String(d.message?.content ?? '').trim(), inputTokens: d.prompt_eval_count ?? 0, outputTokens: d.eval_count ?? 0, model: model || 'llama3.1', costUsd: 0 };
    } };
  }
  if (kind === 'anthropic') {
    const key = await getSecret('ANTHROPIC_API_KEY'); if (!key) return null;
    return { name: 'anthropic', external: true, async complete(system, user, o) {
      guard(); const m = model || 'claude-haiku-5-5';
      const d = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, { model: m, max_tokens: o?.maxTokens ?? 600, system, messages: [{ role: 'user', content: user }] }, 60000);
      const [pi, po] = PRICES[m] ?? [3, 15];
      return { text: String(d.content?.[0]?.text ?? '').trim(), inputTokens: d.usage?.input_tokens ?? 0, outputTokens: d.usage?.output_tokens ?? 0, model: m, costUsd: ((d.usage?.input_tokens ?? 0) * pi + (d.usage?.output_tokens ?? 0) * po) / 1e6 };
    } };
  }
  if (kind === 'openai') {
    const key = await getSecret('OPENAI_API_KEY'); const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''); if (!key && base.includes('api.openai.com')) return null;
    return { name: 'openai', external: !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(base), async complete(system, user, o) {
      if (base.includes('api.openai.com')) guard(); const m = model || 'gpt-4o-mini';
      const d = await post(`${base}/chat/completions`, key ? { authorization: `Bearer ${key}` } : {}, { model: m, max_tokens: o?.maxTokens ?? 600, temperature: 0.1, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }, 60000);
      const [pi, po] = PRICES[m] ?? [0, 0];
      return { text: String(d.choices?.[0]?.message?.content ?? '').trim(), inputTokens: d.usage?.prompt_tokens ?? 0, outputTokens: d.usage?.completion_tokens ?? 0, model: m, costUsd: ((d.usage?.prompt_tokens ?? 0) * pi + (d.usage?.completion_tokens ?? 0) * po) / 1e6 };
    } };
  }
  return null;
}
/** True when `out` introduces numbers or capitalised tokens that are not in `src`. */
export function introducesNewFacts(src: string, out: string): boolean {
  const nums = (t: string) => new Set(t.match(/\$?\d[\d,.]*\s?[KMB]?\b/g)?.map((x) => x.replace(/[\s,]/g, '')) ?? []);
  const caps = (t: string) => new Set(t.match(/\b[A-Z][A-Za-z0-9&]{2,}\b/g) ?? []);
  const sn = nums(src), sc = caps(src);
  for (const n of nums(out)) if (!sn.has(n)) return true;
  for (const c of caps(out)) if (!sc.has(c) && !/^(The|This|These|That|And|For|With|Watch|Expect|Why|What|Large|Given|Here|There|Most|Several|Many)$/.test(c)) return true;
  return false;
}
function ledger(db: Db, p: LlmProvider, r: LlmResult, purpose: string) { db.run(`insert into llm_usage(provider, model, purpose, input_tokens, output_tokens, est_cost_usd) values (?,?,?,?,?,?)`, [p.name, r.model, purpose, r.inputTokens, r.outputTokens, r.costUsd]); }

export async function rephrase(db: Db, p: LlmProvider, text: string): Promise<{ text: string; used: boolean; reason?: string }> {
  try {
    const r = await p.complete('You edit short intelligence summaries for a federal-contracting audience. Rewrite the text to be concise and fluent. Do NOT add, remove or change any fact, number, name or date. Output only the rewritten text.', text, { maxTokens: 400 });
    ledger(db, p, r, 'rephrase');
    if (!r.text || introducesNewFacts(text, r.text)) return { text, used: false, reason: 'rejected: model output introduced new facts or was empty' };
    return { text: r.text, used: true };
  } catch (e) { return { text, used: false, reason: redactText((e as Error).message) }; }
}
/** Ask a model to turn a free-text question into the filter schema; the caller validates the result against a whitelist. */
export async function translateToFilter(db: Db, p: LlmProvider, question: string, schemaHelp: string): Promise<unknown | null> {
  try {
    const r = await p.complete(`You translate questions about federal contracting opportunities into a JSON filter. Output ONLY a JSON object using these optional keys: ${schemaHelp}. Do not invent keys.`, question, { maxTokens: 300 });
    ledger(db, p, r, 'translate'); const m = /\{[\s\S]*\}/.exec(r.text); return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}
