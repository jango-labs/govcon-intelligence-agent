# Connectors and plugins

```ts
interface Connector {
  id: string; name: string;
  access: 'public' | 'key' | 'licensed' | 'file' | 'demo';
  discover(ctx: DiscoverContext): Promise<{ candidates: Candidate[]; coverage: SourceCoverage }>;
}
```

See `src/types.ts` for `Candidate` and `examples/connector-template.ts` for a starter.

## Writing a plugin

1. Copy the template to a location **outside this repository** (or into a gitignored folder).
2. Export a `Connector` as the default export. Return `coverage.status = 'skipped'` when not configured, `'partial'` when you stopped early, `'failed'` on errors. Never hide a shortfall.
3. Map only fields you can verify. Use `urlKind: 'record'` only for genuine per-record deep links; set `solBasis` / `awardBasis` honestly (`government`, `government_estimate`, `imported`, `derived`).
4. Add the path to `config/profile.json` → `sources.plugins`.

## Licensed / commercial sources

This project ships **no** code, schemas or data from paid services. If you hold a subscription whose terms permit it, you can either export CSV and use the built-in CSV importer (map columns via `mapping`), or write a private plugin. You are responsible for compliance with that service's terms. Do not contribute such plugins to this repository.

## CSV import

List files in `sources.csvImports.files`. Recognised headers include title, description, department, agency, solicitation number, release/award date, value, set-aside, NAICS, PSC, vehicle, incumbent, incumbent PIID, incumbent end date, URL (case-insensitive; override with `mapping`).
