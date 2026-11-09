# Architecture

```
connectors (parallel) ──► scope + keyword relevance ──► upsert (canonical identity, field merge)
  SAM, USAspending,            │ review queue for weak evidence      │
  GSA forecast, CSV, plugins   ▼                                     ▼
                         predecessor lookup (PIID → USAspending)   change detection (material thresholds)
                                          │                          │
                                          ▼                          ▼
                                   rescore (6 factors) ──► lifecycle (outage-safe disappearance) ──► snapshots
                                                                       │
                                                                       ▼
                                                      7-sheet Excel report + validation ──► UI / Ask / daemon
```

- **Runtime:** Node 24, TypeScript executed natively (type stripping; `.ts` import extensions; no build). Storage is embedded SQLite (`node:sqlite`, WAL). One runtime dependency: `exceljs`. HTTP server is plain `node:http`.
- **Identity:** a record is matched across runs by source id, SAM notice id, solicitation number or PIID. Fields merge by source rank and date basis; conflicting values are retained, not overwritten silently.
- **Honesty model:** `url_kind` = record | listing | none; date basis = government | government_estimate | imported | derived. The UI, report and Q&A always show them.
- **Partial runs:** each connector returns coverage (`ok | partial | failed | skipped`). A source outage never marks records as disappeared; the report's Data Quality sheet lists coverage.
- **Dry run:** `run --dry-run` wraps the pipeline in a transaction and rolls back.
- **Ask:** deterministic parser → `Filter` → SQL. Optional LLM only translates to a whitelisted filter or rephrases under a no-new-facts guard; usage is ledgered against a monthly cap.
- **UI:** dependency-free vanilla JS, strict CSP, loopback bind by default.
- **Scheduling:** `daemon` (cron in profile time zone, with catch-up) or generated OS scheduler entries.

Code map: `src/connectors/*` sources · `src/pipeline/*` run/store/rescore/lifecycle/report · `src/priority.ts` scoring · `src/ask/*` · `src/server/app.ts` + `web/*` · `src/cli.ts`.
