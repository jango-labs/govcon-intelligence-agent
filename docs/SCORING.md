# Opportunity Intelligence Priority

Each opportunity gets a 0-100 score from six factors, each with a plain-language explanation shown in the UI ("Why this score") and the report.

| Factor | Weight | What it looks at |
|---|---|---|
| Relevance | 30 | Keyword score and categories matched, NAICS/PSC fit, evidence strength |
| Value | 20 | Log-scaled estimated value; forecasts and vehicle ceilings are treated conservatively/neutrally |
| Timeline | 15 | Months until release/award; government-confirmed dates count more than derived ones |
| Recompete | 15 | Classification (confirmed / likely / possible follow-on / expiring / new) and incumbent evidence |
| Maturity | 10 | Notice type and stage (forecast vs. presolicitation vs. solicitation) |
| Agency | 10 | Agency/department fit with your scope |

Tiers: **High ≥ 76, Medium ≥ 64, Low ≥ 52, otherwise Watch.** Weights and thresholds are configurable in `profile.priority`. A *score confidence* label reflects how much of the input was verified rather than estimated.

Scores are heuristics for triage, not predictions of award outcomes.
