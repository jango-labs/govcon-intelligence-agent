// Connector registry: built-in public/key sources plus optional user plugins.
// To add a licensed or private source, implement the Connector interface (src/types.ts) in a file YOU keep outside this repo and list its path
// in profile.sources.plugins. See docs/CONNECTORS.md. No vendor-specific code ships in this repository.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { Connector } from '../types.ts';
import type { Profile as P } from '../config.ts';
import { ROOT } from '../config.ts';
import { samConnector } from './sam.ts';
import { usaspendingConnector } from './usaspending.ts';
import { gsaConnector } from './gsa.ts';
import { csvConnector } from './csv.ts';

export const builtinConnectors = (): Connector[] => [samConnector, gsaConnector, usaspendingConnector, csvConnector];

export async function loadPlugins(profile: P, warn: (m: string) => void): Promise<Connector[]> {
  const out: Connector[] = [];
  for (const p of profile.sources.plugins) {
    const file = resolve(process.env.GOVCON_HOME ?? ROOT, p);
    if (!existsSync(file)) { warn(`plugin not found: ${p}`); continue; }
    try {
      const mod = await import(pathToFileURL(file).href); const c = (mod.default ?? mod.connector) as Connector | undefined;
      if (!c || typeof c.discover !== 'function' || !c.id || !c.name) throw new Error('module must export a Connector (id, name, access, discover) as default');
      out.push(c);
    } catch (e) { warn(`plugin ${p} could not be loaded: ${(e as Error).message}`); }
  }
  return out;
}
