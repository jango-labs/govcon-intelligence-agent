// Secret lookup. Order: real environment variable / .env  →  (optional) OS keyring.
// GOVCON_SECRET_STORE=keyring stores secrets in macOS Keychain or Linux libsecret (secret-tool) instead of a .env file.
// Secrets are never logged, never written to the database or reports, and never sent anywhere except the service they belong to.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

export type SecretName = 'SAM_API_KEY' | 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'GOVCON_UI_TOKEN';
const SERVICE = 'govcon-intelligence-agent';
export const keyringSupported = () => process.platform === 'darwin' || process.platform === 'linux';
export const secretStore = () => (process.env.GOVCON_SECRET_STORE === 'keyring' && keyringSupported() ? 'keyring' : 'env');

export async function getSecret(name: SecretName): Promise<string | null> {
  const v = process.env[name]; if (v) return v;
  if (secretStore() !== 'keyring') return null;
  try {
    if (process.platform === 'darwin') return (await exec('/usr/bin/security', ['find-generic-password', '-s', `${SERVICE}.${name}`, '-a', SERVICE, '-w'])).stdout.replace(/\n$/, '') || null;
    return (await exec('secret-tool', ['lookup', 'service', SERVICE, 'name', name])).stdout.replace(/\n$/, '') || null;
  } catch { return null; }
}
export async function setSecret(name: SecretName, value: string): Promise<void> {
  if (/[\r\n]/.test(value)) throw new Error('secret must not contain line breaks');
  if (process.platform === 'darwin') {
    // commands go through stdin ("security -i") so the value never appears in a process list; hex avoids quoting issues
    await new Promise<void>((res, rej) => {
      const p = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] }); let err = '';
      p.stderr.on('data', (d) => (err += d)); p.on('error', rej);
      p.on('close', (c) => (c === 0 && !/error/i.test(err) ? res() : rej(new Error('keychain write failed'))));
      p.stdin.write(`add-generic-password -U -s "${SERVICE}.${name}" -a "${SERVICE}" -X "${Buffer.from(value, 'utf8').toString('hex')}"\n`); p.stdin.end();
    });
  } else if (process.platform === 'linux') {
    await new Promise<void>((res, rej) => {
      const p = spawn('secret-tool', ['store', '--label', `${SERVICE} ${name}`, 'service', SERVICE, 'name', name], { stdio: ['pipe', 'ignore', 'ignore'] });
      p.on('error', () => rej(new Error('secret-tool (libsecret) is not installed'))); p.on('close', (c) => (c === 0 ? res() : rej(new Error('secret-tool failed'))));
      p.stdin.write(value); p.stdin.end();
    });
  } else throw new Error('OS keyring is not supported on this platform; use a .env file');
}
export async function deleteSecret(name: SecretName): Promise<void> {
  try {
    if (process.platform === 'darwin') await exec('/usr/bin/security', ['delete-generic-password', '-s', `${SERVICE}.${name}`, '-a', SERVICE]);
    else if (process.platform === 'linux') await exec('secret-tool', ['clear', 'service', SERVICE, 'name', name]);
  } catch { /* absent */ }
}
/** Show only the presence and length class of a secret, never the value. */
export const mask = (v: string | null) => (v ? `set (${v.length} chars)` : 'not set');
