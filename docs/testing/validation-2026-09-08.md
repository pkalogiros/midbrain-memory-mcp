# Multi-client harness validation — 2026-09-08

This is a review checkpoint, not release sign-off. The full required matrix
finished with **93 PASS, 27 FAIL, and 1 BLOCKED**, with clean real-home isolation.
Its frozen inputs and failures are retained. Focused follow-ups validate specific
fixes; they do not make the original matrix green.

## Review changes

- `f84c5f6`: synchronous Claude Stop capture and migration. Radu's release review is pending.
- `5b1f1fe`: one-layer NanoClaw transport-envelope decoding. Radu's release review is pending.
- `9479c65`: the harness changes, including NanoClaw's documented formatting-retry exception.
- Follow-up harness fixes: inspect the installed baseline with its own adapter;
  install Hermes's MCP extra and read its current-turn session exports; retain
  OpenCode's native tool evidence and complete MCP output files; isolate NanoClaw
  agent files from host projects; wait for both capture roles in marker checks;
  block unverified API readback and warmed-home cold-start claims.

These follow-ups add no production dependencies. Every observed native NanoClaw
reply still requires exactly one capture. The adapter retains raw transcripts;
the product hook decodes recognized user envelopes.

## Evidence

Reports are retained under `<run-root>/runs/<run-id>/report.md`; private run homes
are not committed to this repository.

| Run | Source | Coverage | Result |
|---|---|---|---|
| `20260908-093157-c670` | `9479c65` | Full `--required` registry/upgrade matrix | 93 PASS, 27 FAIL, 1 BLOCKED; isolation clean |
| `20260908-101835-f1f3` | `0c854cb` | Hermes upgrade, fresh-session recall, markers, rule compliance | 7 PASS; isolation clean |
| `20260908-110034-ea0b` | `fcf1047` | Claude ↔ NanoClaw recall with separate agent workspaces | 10 PASS; isolation clean |

The retained Codex → OpenCode case also passes six parser/scoring checks under
`f3b21ae`, using its original native stream and the complete MCP response file.
This recheck is stored separately in the required run's `opencode-parser-recheck/`;
it does not replace the original matrix result.

The local API became unhealthy during the required run. A separate probe also
timed out. PostgreSQL, the proxy, and LocalStack remained healthy; restarting
only `memory-api` restored `/health`. The required run's
`infrastructure-events.json` records this intervention. Outage-affected missing
capture or recall evidence cannot establish a client regression.

The baseline-inspection fix was verified independently with the published Claude
installation: its own adapter reports fresh, while the newer candidate adapter
correctly reports the old asynchronous hooks stale.

`VITEST_MAX_WORKERS=4 npm run check` passed: 1,283 tests, two client-inapplicable
skips, and 224 additional copied-topology tests. Four workers avoid contention
with live client runs without changing any test assertions or timeouts.

## Findings still requiring evidence

- Codex's literal-marker case missed the assistant capture. NanoClaw's marker
  case missed both capture roles; its native hook reported a missing `ajv`
  dependency and MCP startup timed out. NanoClaw also missed state-change rows.
- Claude performed a local read before memory recall in fresh-session testing.
  OpenCode's plugin-only case recovered the value but split the required exact
  retrieval anchor. Strict rule checks remain failures.
- Claude's upgrade failure was the previous release's missing assistant capture;
  candidate capture and migration passed. The installed-baseline inspection and
  Hermes/OpenCode evidence defects have separate follow-up verification above.
- The API outage prevents treating all missing rows as client regressions. A
  healthy-service rerun must distinguish infrastructure failures from client bugs.

All five clients passed initial capture/metadata checks and clean no-match
behavior. All 20 ordered cross-client pairs ran: 15 recalls passed and five failed.
No failed original result was overwritten by a parser recheck or later run.

The three completed runs' 672 report/evidence text files contained no configured
provider/test credentials in the scan. Private run homes retain credentials and
are intentionally excluded from committed evidence.

## Reproduce

Configure dedicated test/provider credentials in `harness/.env` and a durable
`MIDBRAIN_HARNESS_ROOT`. The original run used macOS arm64, Node 24.3.0,
Claude Code 2.1.258, Codex 0.150.1, and the manifest's pinned NanoClaw image/source.

```sh
MIDBRAIN_HARNESS_CLAUDE_MODEL='claude-opus-5[1m]' \
MIDBRAIN_HARNESS_CODEX_MODEL=gpt-5.6-sol \
MIDBRAIN_HARNESS_OPENCODE_VERSION=1.18.29 \
MIDBRAIN_HARNESS_OPENCODE_MODEL=anthropic/claude-sonnet-4-6 \
MIDBRAIN_HARNESS_HERMES_VERSION=0.19.0 \
MIDBRAIN_HARNESS_HERMES_MODEL=claude-sonnet-4-5 \
MIDBRAIN_HARNESS_NANOCLAW_MODEL=claude-sonnet-4-5 \
node harness/run.mjs run --mode registry --upgrade --required
```

## Release boundaries

The corrected harness still needs a required run against a healthy API. Codex
persisted hook approval requires interactive before/after evidence, and Claude's
cold-first-turn case requires a separate clean-home run without the upgrade
prelude. Radu's review of the two product commits remains required. CI/release
integration and broader OS validation are separate work.
