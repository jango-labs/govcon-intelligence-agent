// Template for a private/licensed data-source plugin. Keep YOUR copy outside this repository (or gitignored)
// and list its path in config/profile.json -> sources.plugins. See docs/CONNECTORS.md.
// You are responsible for holding the licence/terms that permit your use of the data source.
import type { Connector, Candidate } from '../src/types.ts';

const connector: Connector = {
  id: 'my_source',
  name: 'My licensed source',
  access: 'licensed',
  async discover(ctx) {
    const token = await ctx.getSecret('GOVCON_PLUGIN_TOKEN' as never); // or read process.env yourself
    if (!token) return { candidates: [], coverage: { source: 'my_source', status: 'skipped', detail: 'No token configured' } };
    const candidates: Candidate[] = [];
    // Fetch from your source and map into Candidate objects. Only set fields you can verify;
    // set urlKind to 'record' only for real per-record deep links and use date bases honestly.
    candidates.push({
      source: 'my_source', sourceId: 'example-1', title: 'Example opportunity', department: 'DoD', agency: 'Example Agency', subagency: '',
      solDate: ctx.today, solBasis: 'imported', urlKind: 'none',
    });
    return { candidates, coverage: { source: 'my_source', status: 'ok', detail: `${candidates.length} records`, fetched: candidates.length } };
  },
};
export default connector;
