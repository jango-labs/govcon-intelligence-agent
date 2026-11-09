// Structured logging with secret redaction. Logs never contain API keys or tokens.
const SECRET_KEYS = /pass(word)?|token|secret|api[_-]?key|authorization|cookie|credential/i;
export function redactText(s: string): string {
  return s.replace(/([?&](?:api_key|apikey|key|token)=)[^&\s"']+/gi, '$1[redacted]').replace(/\b(sk-[A-Za-z0-9_-]{16,}|[A-Za-z0-9]{40,})\b/g, '[redacted]');
}
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (typeof value === 'string') return redactText(value.length > 2000 ? value.slice(0, 2000) + '…' : value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactText(value.message) };
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    return out;
  }
  return value;
}
type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  const min = order[(process.env.GOVCON_LOG_LEVEL as Level) ?? 'info'] ?? 20;
  if (order[level] < min) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg: redactText(msg), ...(redact(fields) as object) });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
}
export const logger = {
  debug: (m: string, f?: Record<string, unknown>) => log('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => log('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => log('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => log('error', m, f),
};
