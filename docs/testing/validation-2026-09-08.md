# Multi-client harness validation — 2026-09-08

**Focused validation passed; the latest required matrix was interrupted by an
Anthropic billing error. There is no complete passing release matrix yet.**

## Current changes

- `477bd79`: clarify MidBrain-before-local-memory ordering and complete retrieval
  IDs. Migrate only recognized generated instruction blocks; preserve custom rules.
- `debc9c5`: retain NanoClaw's installer-populated npm cache across container wakes,
  explicitly clear npx resolution during upgrades, run Claude's cold first turn in
  a separate fresh home, and verify native Codex hook approval before/after `/hooks`.
- `03b6271`: drain pending OpenCode capture work on native plugin shutdown, bounded
  to 30 seconds. Ordinary chat remains asynchronous. This fixes the observed POST
  that started but did not finish before CLI exit.
- `07ffe53`: retain native provider-error evidence and report it as BLOCKED. A
  synthetic billing-error message must not count as a successful assistant turn.

Earlier product changes remain separate: `f84c5f6` waits for Claude's native Stop
capture and migrates owned asynchronous hooks; `5b1f1fe` decodes recognized NanoClaw
user transport envelopes once. The adapter retains raw transcripts. NanoClaw's
formatting-retry exception requires exactly one capture per native assistant reply.
No production dependencies were added.

## Evidence

Reports live under `<run-root>/runs/<run-id>/report.md`. Private run homes and raw
transcripts are not committed to this repository.

| Run | Source | Coverage | Result |
|---|---|---|---|
| `20260908-093157-c670` | `9479c65` | Original full required registry/upgrade matrix | 93 PASS, 27 FAIL, 1 BLOCKED; isolation clean |
| `20260908-101835-f1f3` | `0c854cb` | Hermes upgrade, recall, markers and compliance | 7 PASS; isolation clean |
| `20260908-110034-ea0b` | `fcf1047` | Claude ↔ NanoClaw recall with separate workspaces | 10 PASS; isolation clean |
| `20260908-114400-6a43` | `22fac5c` | Fresh reproduction of Codex's marker-capture failure | 4 PASS; isolation clean |
| `20260908-115033-5182` | `debc9c5` | Four-client markers, continuity, rules and special cases | 32 PASS, 1 FAIL; isolation clean |
| `20260908-121346-7c12` | `03b6271` | Real OpenCode plugin-only capture and exact-anchor recall | 4 PASS; isolation clean |
| `20260908-121539-de44` | `03b6271` | New full required registry/upgrade matrix | Interrupted: provider billing; isolation clean |

The sole failure in `115033-5182` was OpenCode's missing assistant capture in the
plugin-only case. The subsequent shutdown fix passed `121346-7c12`. The earlier
Codex marker failure did not recur in either focused run; no speculative Codex
capture change was made. All four focused clients passed fresh-session recall and
strict memory-first/exact-anchor checks. All NanoClaw lifecycle cases passed.

The focused Codex approval case observed zero capture before approval, then one
user and one assistant capture in a new process without the bypass. The native
UI showed all three MidBrain hooks active after individual approval; its terminal
evidence is retained in `evidence/codex/s10-client-specific/approval-ui.txt`.
Claude's cold-first-turn check passed in a separate home and npm cache.

The latest required attempt stopped during NanoClaw post-upgrade capture. Its
native transcript identifies `billing_error`, HTTP 400, `isApiErrorMessage: true`,
and “Credit balance is too low.” It retains `interruption.json` and an explicit
interruption report, not a complete parity report. Its 27 API health probes all
succeeded; none exceeded five seconds. No service restart occurred during that
attempt. The preceding focused run recorded three brief five-second health-probe
timeouts followed by recovery; these remain in its evidence.

Original failed reports are unchanged. Earlier parser rechecks and focused passes
do not replace a complete required matrix on the corrected implementation.

## Verification and cleanup

Final `VITEST_MAX_WORKERS=4 npm run check` passed: 54 files, 1,288 tests, two
client-inapplicable skips, and 224 additional copied-topology tests. Regression
coverage includes pending capture at shutdown, the shutdown deadline, generated
rule migration, cache isolation, and native provider-error classification.

A scan of 232 new report/evidence text files found no configured credentials.
Private run homes retain credentials and must remain private. No run-owned Docker
containers remained. The four API services started for validation were restored
to their original stopped state. Nothing was pushed or published externally.

## Resume the required matrix

Fund the configured Anthropic key, or configure a funded key in `harness/.env`.
Start the local test API and its dependencies if using the local stack. Keep the
same dedicated test credentials, durable run root, and pinned client configuration.
Run from a terminal so native Codex approval can be completed:

```sh
MIDBRAIN_HARNESS_CLAUDE_MODEL='claude-opus-5[1m]' \
MIDBRAIN_HARNESS_CODEX_MODEL=gpt-5.6-sol \
MIDBRAIN_HARNESS_OPENCODE_VERSION=1.18.29 \
MIDBRAIN_HARNESS_OPENCODE_MODEL=anthropic/claude-sonnet-4-6 \
MIDBRAIN_HARNESS_HERMES_VERSION=0.19.0 \
MIDBRAIN_HARNESS_HERMES_MODEL=claude-sonnet-4-5 \
MIDBRAIN_HARNESS_NANOCLAW_MODEL=claude-sonnet-4-5 \
node harness/run.mjs run --mode registry --upgrade --required --interactive
```

These runs used macOS arm64, Node 24.3.0, Claude Code 2.1.258, Codex 0.150.1,
and the manifest's pinned NanoClaw source/image. NanoClaw deployment configuration
must preserve the npm cache as described in the harness README. OpenCode shutdown
draining requires a client implementing the plugin `dispose` hook (verified on
1.18.29).

Release sign-off still needs a complete required run and Radu's review of the
product changes. CI/release integration and broader OS validation remain separate
work.
