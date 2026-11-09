import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/db.ts';
import { loadExampleProfile } from '../src/config.ts';

export const tmp = () => mkdtempSync(join(tmpdir(), 'govcon-test-'));
export const memDb = () => new Db(':memory:');
export const profile = () => { const p = loadExampleProfile(); return p; };
