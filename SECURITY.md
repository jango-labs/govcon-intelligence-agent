# Security Policy

## Reporting a vulnerability

Please report privately through GitHub's **"Report a vulnerability"** (Security advisories) on this repository rather than a public issue. Include steps to reproduce. We aim to acknowledge within 7 days. This is a volunteer project; there is no bounty.

## Design

- **Local only.** The web UI binds to `127.0.0.1` by default. Binding elsewhere requires `GOVCON_UI_TOKEN`; the server refuses to start otherwise.
- **No telemetry, no phone-home, no auto-update.** Outbound requests go only to sources you enable, and to an LLM provider only if you configure one.
- **Secrets** come from `.env` (gitignored) or the OS keyring. They are never written to the database, reports or logs; log lines and URLs are redacted.
- **UI hardening:** strict Content-Security-Policy, Host-header allow-list (DNS-rebinding defence), CSRF header on state-changing requests, `textContent`-only rendering, path-traversal protection on report downloads.
- **LLM boundary:** a model can only translate a question into a whitelisted filter or rephrase results under a no-new-facts check. It never receives secrets, and is off by default.
- **Dependencies:** one runtime dependency (`exceljs`). CI runs `npm audit` and a secret scan.

## Your responsibilities

Keep `.env` private, rotate any key you accidentally expose, use the data in line with each provider's terms, and don't expose the UI to a network without a token and TLS termination you control. Run `npm run scan:secrets` before publishing a fork.
