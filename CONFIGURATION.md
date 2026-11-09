# Configuration

Two places, by design: **secrets and machine settings** in `.env`; **what you are hunting for** in `config/profile.json`. Both are gitignored; only the `.example` files are committed.

## `.env` (see `.env.example`)

| Variable | Default | Purpose |
|---|---|---|
| `SAM_API_KEY` | empty | Your free SAM.gov key. |
| `GOVCON_DATA_DIR` | `./data` | Database, reports, cache. |
| `GOVCON_PROFILE` | `./config/profile.json` | Profile path. |
| `GOVCON_SECRET_STORE` | `env` | `env` or `keyring` (macOS Keychain / Linux libsecret). |
| `GOVCON_HOST` / `GOVCON_PORT` | `127.0.0.1` / `8787` | UI bind address. |
| `GOVCON_UI_TOKEN` | empty | **Required** if the host is not loopback. |
| `GOVCON_LLM_PROVIDER` | `none` | `none`, `ollama`, `anthropic`, `openai`. |
| `GOVCON_LLM_MODEL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OLLAMA_URL` | | Only for the provider you choose. |
| `GOVCON_LLM_MONTHLY_CAP_USD` | `0` | Hard cap; `0` blocks paid calls. |
| `GOVCON_LOG_LEVEL` | `info` | |

## `config/profile.json` (see `config/profile.example.json`)

- `profileName`, `timezone`, `schedule` (5-field cron, e.g. `0 6 * * *`), `windowMonths` (look-ahead, default 24).
- `scope.departments`: any of DoD, DHS, DOJ, HHS, VA. `excludeComponents`: agencies/components to drop. `otherAgencyForecasts`: keep forecasts from other departments.
- `filters`: `naics` list, `naicsMode` (`prefer` = boosts relevance, `require` = drops others), `noticeTypes`, `setAsides`, `vehicles`, `minValueUsd`.
- `keywords[]`: `{term, category, synonyms[], exclusions[], weight, enabled}`. Synonyms may be regular expressions. Manage with `govcon keywords list|add|test`.
- `relevance`: `threshold` (default 25) and `evidence` (`strong` requires explicit keyword evidence in the text; weaker matches go to a review queue).
- `priority.weights` / `priority.thresholds`: defaults are relevance 30, value 20, timeline 15, recompete 15, maturity 10, agency 10; High ≥ 76, Medium ≥ 64, Low ≥ 52. Weights should sum to 100.
- `derive`: `rfpLeadMonths` (lead time assumed between contract expiry and RFP for *derived* dates), `minExpiry`.
- `changeThresholds`: `dateShiftDays` (14), `valueChangePct` (20).
- `sources.*`: per-source `enabled` and limits (`maxCalls`, `maxPages`, `lookbackDays` ...). `csvImports.files` lists CSV exports with optional column `mapping`. `plugins` lists paths to your own connector modules.
- `llm`: `provider`, `model`, `monthlyCapUsd` (overridden by env).

`govcon config` prints the effective configuration with secrets masked. Invalid profiles fail fast with a message naming the field.
