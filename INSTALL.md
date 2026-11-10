# Installation

## Requirements

- **Node.js 24+** (`node --version`). The tool uses the built-in `node:sqlite` module and runs TypeScript natively, so there is no build step and no database server.
- About 100 MB of disk for dependencies; reports are ~50-500 KB each.
- Optional: a free **SAM.gov API key** (see below).

Tested: macOS (Apple Silicon), Node 24. **Linux, Windows and Docker are supported by design but have not been tested by the maintainers yet**; please report results in an issue.

## Steps

```bash
git clone https://github.com/jango-labs/govcon-intelligence-agent.git
cd govcon-intelligence-agent
npm install
npm run demo
```

`npm run demo` uses invented data and needs no network or credentials. It writes a sample workbook under `data/demo/reports/`.

### Guided setup

```bash
npm run setup
```

It checks Node, copies `config/profile.example.json` to `config/profile.json`, creates `.env`, optionally stores your SAM.gov key, validates the profile and offers a demo run. Non-interactive: `npm run setup -- --yes`.

Edit `config/profile.json` to set your keywords, NAICS codes and departments ([CONFIGURATION.md](CONFIGURATION.md)).

### Get a SAM.gov API key (free)

1. Create/sign in to an account at <https://sam.gov>.
2. Open *Account Details* and request a **Public API Key**.
3. Put it in `.env` as `SAM_API_KEY=...` (or let `npm run setup` store it in your OS keyring). Never commit `.env`.

Without a key, the SAM.gov source is reported as *skipped* and the other sources still run.

### First real run

```bash
npm run doctor -- --live   # connectivity check (makes a few small requests)
npm run run                # discovery + report
npm run serve              # UI at http://127.0.0.1:8787
```

The first run is slower (it builds the baseline; everything is "new"). Later runs report only changes.

### Daily schedule

- `npm run daemon` stays running and fires at the profile's `schedule` (cron, profile time zone, with catch-up after sleep).
- `npm run govcon -- schedule print` shows a launchd / systemd / Task Scheduler entry; `schedule install` installs it for your user only; `schedule uninstall` removes it.

### Docker (experimental, untested)

```bash
cp .env.example .env && docker compose up -d
```
Runs a `daemon` service (daily run) and a `ui` service (published on `127.0.0.1:8787` only; requires `GOVCON_UI_TOKEN`). Data lives in a named volume. See `docker-compose.yml`.

## Upgrade

`git pull && npm install`. The database carries a schema version for future migrations (none required yet). Back up `data/` first if you care about history.

## Uninstall

`npm run govcon -- schedule uninstall`, delete the project folder (and `data/`), and remove any `govcon-intelligence-agent` keyring entries if you used the keyring.

## Troubleshooting

`npm run doctor` explains most problems. A run that ends **PARTIAL** lists which source hit a limit or failed and why; it is not an error in your setup.
