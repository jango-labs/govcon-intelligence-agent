#!/usr/bin/env node
// Dependency-free secret / private-data scanner for the working tree (and optionally full git history: --history).
// Exit code 1 if anything is found. Patterns are deliberately conservative; review every hit.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['Anthropic key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9]{32,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['SAM.gov-style key literal', /\bSAM-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['assigned secret literal', /\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*["'][A-Za-z0-9_\-\/+=]{20,}["']/i],
  ['absolute home path', /\/(?:Users|home)\/[a-z0-9._-]+\/(?!you\b|name\b|<)/i],
  ['macOS volume path', /\/Volumes\/[A-Za-z0-9 ._-]+\//],
  ['private IPv4', /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b/],
  ['email address', /\b[A-Za-z0-9._%+-]+@(?!users\.noreply\.github\.com|example\.(?:com|org)|anthropic\.com)[A-Za-z0-9.-]+\.[a-z]{2,}\b/i],
];
// Project-specific words that must never appear (extend locally via GOVCON_SCAN_EXTRA="word1,word2").
const WORDS = ['unissant', 'nextstage', 'govwin', 'g2x', 'jangounwalla', ...(process.env.GOVCON_SCAN_EXTRA ?? '').split(',').filter(Boolean)];
// Allowed contexts for vendor words: docs that explain the licensed-source boundary.
const WORD_ALLOWED_FILES = /^(docs\/(LICENSING|CONNECTORS|DATA_SOURCES)\.md|README\.md|SECURITY\.md|CHANGELOG\.md|scripts\/scan-secrets\.mjs|\.github\/.*)$/;
const SKIP = /^(package-lock\.json|node_modules\/|docs\/images\/|examples\/.*\.xlsx$|.*\.(png|jpg|ico|svg)$)/;

const history = process.argv.includes('--history');
const hits = [];
function scan(label, file, text) {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const [name, re] of PATTERNS) if (re.test(line)) hits.push(`${label}${file}:${i + 1}  ${name}`);
    const low = line.toLowerCase();
    if (!WORD_ALLOWED_FILES.test(file)) for (const w of WORDS) if (low.includes(w)) hits.push(`${label}${file}:${i + 1}  forbidden word "${w}"`);
  });
}
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28 });
let files;
try { files = git('ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter(Boolean); }
catch { console.error('Not a git repository (or git missing).'); process.exit(2); }
for (const f of files) { if (SKIP.test(f)) continue; try { scan('', f, readFileSync(f, 'utf8')); } catch { /* binary/unreadable */ } }
if (history) {
  for (const c of git('rev-list', '--all').split('\n').filter(Boolean)) {
    for (const f of git('ls-tree', '-r', '--name-only', c).split('\n').filter(Boolean)) {
      if (SKIP.test(f)) continue;
      try { scan(`[${c.slice(0, 8)}] `, f, git('show', `${c}:${f}`)); } catch { /* binary */ }
    }
  }
  // Commit metadata (author names/emails/messages)
  const meta = git('log', '--all', '--format=%an <%ae> | %cn <%ce> | %s');
  scan('[commit metadata] ', 'log', meta);
}
if (hits.length) { console.error(`Potential secrets / private data found (${hits.length}):\n` + [...new Set(hits)].join('\n')); process.exit(1); }
console.log(`scan-secrets: clean (${files.length} files${history ? ', full history' : ''}).`);
