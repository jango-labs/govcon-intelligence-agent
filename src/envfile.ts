// Safe .env editing: update or append KEY=value, keep everything else, restrict permissions to the owner (POSIX).
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.ts';

export const envPath = () => join(process.env.GOVCON_HOME ?? ROOT, '.env');
export function setEnvValue(key: string, value: string, file = envPath()): void {
  if (/[\r\n]/.test(value)) throw new Error('value must not contain line breaks');
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`); let done = false;
  const out = lines.map((l) => (re.test(l) ? ((done = true), `${key}=${/[\s#"']/.test(value) ? JSON.stringify(value) : value}`) : l));
  if (!done) { if (out.length && out[out.length - 1] !== '') out.push(''); out.splice(out.length - (out[out.length - 1] === '' ? 1 : 0), 0, `${key}=${/[\s#"']/.test(value) ? JSON.stringify(value) : value}`); }
  writeFileSync(file, out.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* not supported (Windows) */ }
}
