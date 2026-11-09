#!/usr/bin/env node
// Tiny launcher so `govcon ...` works on Windows, macOS and Linux without a build step (Node 24 runs TypeScript natively).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const [major] = process.versions.node.split('.').map(Number);
if (major < 24) { console.error(`govcon needs Node.js 24 or newer (found ${process.versions.node}). Install it from https://nodejs.org`); process.exit(1); }
const here = dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(here, '..', 'src', 'cli.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
