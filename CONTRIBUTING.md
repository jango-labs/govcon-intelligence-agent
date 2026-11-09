# Contributing

Thanks for helping. Please:

1. Open an issue before large changes.
2. `npm install && npm test && npm run typecheck && npm run scan:secrets`; all must pass.
3. Keep the **public-source / licensed-source boundary**: do not add code, data, scraped content or API wrappers for paid/proprietary services to this repository. Those belong in a private plugin ([docs/CONNECTORS.md](docs/CONNECTORS.md)).
4. Tests and fixtures must be **synthetic**. Never commit real keys, real company data, exported reports or database files.
5. Preserve honesty rules: never present an estimate as a verified fact; every link/date needs its kind/basis.
6. Scoring changes need a docs update ([docs/SCORING.md](docs/SCORING.md)) and tests.

Style: TypeScript with `.ts` import extensions, no build step, minimal dependencies. By contributing you agree your work is licensed under the MIT License.
