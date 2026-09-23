# Multi-client behavioral harness

**For MCP integration testing, start here** from the repository root after `npm ci`:

```bash
# All five clients: MCP contracts and native discovery, no models.
node harness/run.mjs dry-smoke --install-clients
# Real Pi tool dispatch and returned provider context, no LLM inference.
node harness/run.mjs scripted-smoke --clients pi --install-clients
```

Claude and Codex must already be installed; Hermes installation needs `uv`.
Both commands print an offline `report.html` path and exit nonzero on incomplete,
blocked or failed coverage. Neither needs model or MidBrain credentials.

For a few real-model tool checks, use `live-smoke` with explicit models and
`--execute`. For memory behavior, use the existing behavioral suite:

```bash
node harness/run.mjs run --simple --mode registry --clients claude,codex,hermes,nanoclaw --concurrency 4
```

That behavioral command sends three real-model prompts per client. Use `--high`
or `--xhigh` for broader behavioral coverage. Press Ctrl+C to stop any run.

---

Tests whether real AI clients can save and retrieve memory through MidBrain. Each run
installs the version under test in a private home and checks prompts, answers, stored
memories and tool calls.

Start with the [setup and usage guide](../docs/testing/harness-how-it-works.md), or open
its [offline HTML version](../docs/testing/harness-how-it-works.html).
The default clients are Claude Code, Codex, OpenCode, Hermes and NanoClaw.
Pi is optional in tests, but its installer integration ships in the product.

Pi is available explicitly with `--clients pi` or, for cross-client recall,
`--clients claude,pi`. The existing five-client default and required release
matrix are unchanged. Pi is installed under the run's tools directory using
`@earendil-works/pi-coding-agent`; set `MIDBRAIN_HARNESS_PI_VERSION` to pin it and
`MIDBRAIN_HARNESS_PI_MODEL` to choose an Anthropic model (default
`claude-haiku-4-5`). It uses the dedicated harness `ANTHROPIC_API_KEY`.

```bash
node harness/run.mjs run --clients pi --scenarios s01,s03,s06 --mode registry --keep
node harness/run.mjs run --clients claude,pi --scenarios s01,s02 --mode registry --keep
```

NanoClaw prompts preserve the requested answer inside its required
`<message to="harness">...</message>` delivery wrapper, avoiding unnecessary format
retries. The exact prompt sent is saved as evidence; capture and recall checks
are unchanged. Native hook timeouts appear as console warnings and in turn JSON.

Pi's native extension captures `message_end` events; the driver records its JSON
stream and native session files. No capture is replayed by the harness. Use a
clean candidate run for Pi; releases predating Pi support cannot supply a valid
`--upgrade` baseline.

Fresh validation on 2026-09-10: NanoClaw capture, cold wake, resume and legacy
recovery passed **10/10 checks in 2m 18s** (`20260910-132046-7f06`); Pi capture
and fresh-session recall passed **10/10 in 1m 09s** (`20260910-132050-ce74`).
Both used four prompts and left real homes unchanged. The separate Claude/Codex/
Hermes upgrade refresh passed current-candidate capture for all three; its two
remaining failures were previous-release Claude capture and a local API 401 during
Hermes accepted-hook capture. These are targeted checks, not a full release gate.

## Dry-smoke: test the MCP without models

```bash
node harness/run.mjs dry-smoke --install-clients
```

This mode uses the existing candidate, installer, isolated homes and reports. It
calls all 12 MCP tools against a local synthetic API and separately checks native
connection/discovery in OpenCode, Claude, Codex, Hermes and Pi. It sends no model
prompts and needs no API keys or Docker. Claude/Codex must be on PATH; missing
OpenCode/Hermes/Pi can be installed run-locally (`uv` is needed for Hermes).

Failures include invalid arguments, unavailable/malformed API responses,
missing/empty credentials and corrupt account state, followed by recovery checks, concurrent calls and fresh-process restart.
Missing clients and unsupported probes are **BLOCKED**, and **FAIL, BLOCKED or
incomplete coverage all exit nonzero**. Direct tool execution and native discovery
are reported separately; memory quality and model behavior remain untested.
The report includes an MCP context preview with tool schemas, arguments, results
and errors. JSON, Markdown and incremental event logs are saved per client; no
native model request is constructed.
The preview separates arguments and responses, labels scenario verdicts, and
supports searching, filtering and links to individual exchanges. Damaged or
inconsistent event logs are retained as incomplete evidence and fail validation.
The HTML and Markdown reports also show per-tool discovery, schema, positive, invalid-input and recovery coverage. Recovery gaps are labelled NOT COVERED.
See [dry-smoke coverage, failure handling and OS limits](../docs/testing/dry-smoke.md) for the exact checks.

## Scripted-smoke: native tool dispatch without LLM inference

```bash
node harness/run.mjs scripted-smoke --clients pi --install-clients
```

This mode launches **real Pi, OpenCode, Hermes, Claude Code or Codex** with the installed MCP and a local scripted provider.
Select one per run with `--clients pi`, `--clients opencode`, `--clients hermes`, `--clients claude` or `--clients codex`.
The script requests every one of the 12 tools, then injects a backend 503 and asks
for a successful follow-up. It advances only when the native client returns the correlated result.
Native events, MCP arguments/results and fixture HTTP receipts must agree. One
Pi, Hermes, Claude Code or Codex session is capped at 14 tool calls and 15 local completion requests. OpenCode
also calls a second MCP server exposing its own `memory_search`: 15 tool calls
and 16 local completion requests. Hermes also permits at most 16 local capability-discovery GETs; Claude permits up to four startup HEAD probes. These reads are logged separately. All sessions have a 90-second deadline. The peer query
must reach the independent server and must never reach MidBrain.

Raw MCP schemas are checked separately from the provider catalog. Codex’s provider schema omits numeric bounds and defaults; its native session receipts link provider IDs to CLI events. Claude uses Messages tool blocks, and Codex uses namespaced Responses calls. Claude and Codex must already be installed on PATH.

The report includes **actual request bodies sent by the client to the local provider**:
tool definitions, conversation messages, arguments and returned results, with
synthetic credentials redacted. Provider requests and MCP events are also logged
incrementally. This adds native dispatch evidence beyond dry-smoke's direct probes;
it makes zero LLM calls and does not assess model decisions or memory quality.

The supported adapters are Pi, OpenCode, Hermes, Claude Code and Codex. Other clients and combined selections
are rejected explicitly. A missing native client is BLOCKED; failed or incomplete evidence exits nonzero. No real-provider
fallback is configured. See [the scripted-smoke reference](../docs/testing/scripted-smoke.md) for
commands, evidence boundaries, failure handling and recorded validation.


## Recommended release layers

1. Run `npm run check` on each change for deterministic regressions, error envelopes and isolation rules.
2. Run native dry-smoke and scripted-smoke on MCP/installer/client integration changes. The `MCP integration (no models)` workflow is configured for Linux/macOS, with reports retained even on failure. [All twelve native jobs passed on Linux/macOS](https://github.com/pkalogiros/midbrain-memory-mcp/actions/runs/35875387911) for commit `6c29a38`.
3. Before release, run a small explicitly approved live-smoke configuration to check the real-model boundary. Inspect native usage and accounting gaps; call/time limits are not a dollar budget.
4. Run the full behavioral suite when capture, retrieval or memory behavior changes.

Current local evidence covers all five dry-smoke clients and native scripted Pi,
OpenCode, Hermes, Claude Code and Codex on macOS arm64. Operational failures carry `isError: true`;
empty successes remain successful. Account creation now rolls back a created agent
when key minting fails, and reports the orphan ID if cleanup fails. Tests exercise
both cleanup outcomes, credential preservation and subsequent recovery.

Remaining gaps include a paid live-smoke result,
native Windows validation, cancellation and timed-out
request recovery, and interrupted account transactions across process restarts.
These gaps remain visible rather than counting as passing coverage.

[Standard CI passed on Linux, macOS and Windows](https://github.com/pkalogiros/midbrain-memory-mcp/actions/runs/35875387757) for the same commit. These are programmatic tests; native Windows client smoke remains unvalidated.

## Hand over MCP review evidence

```bash
node harness/run.mjs review-bundle /path/to/dry-run /path/to/pi-run /path/to/opencode-run --output /path/to/new-review
node harness/run.mjs verify-review /path/to/new-review
```

Open the exported `index.html` for a comparison of recorded runs and links to their
reports. Export selects synthetic evidence, redacts fixture credentials, excludes
private homes/configuration, and generates a SHA-256 manifest. Source runs stay
unchanged. Missing evidence or unsafe paths fail export. Verification detects
changed, missing or unlisted files; it verifies bundle integrity, not test success
or authorship. Failed and interrupted runs retain their status. This is review
evidence, not release sign-off. See [review export and verification](../docs/testing/mcp-review-bundles.md).

## Live-smoke: a small real-model tool check

```bash
# Plan only: no credentials loaded and no model calls.
node harness/run.mjs live-smoke --config harness/live-smoke.example.json --clients claude,codex
# Explicit execution: two bounded native sessions per client against a synthetic API.
node harness/run.mjs live-smoke --config harness/live-smoke.example.json --clients claude,codex --execute
```

This mode checks **Call and consume** and **Error and recovery**, using the real
client launcher and installed MCP. Native calls, recorded MCP exchanges, fixture
HTTP requests and fresh verification values in the answer must agree. It tests
explicit tool execution, not memory quality. Provider credentials are required;
a MidBrain deployment/key and Docker are not.

Models are explicit per client. The example includes Claude Code on Haiku, Codex
and OpenCode on GPT-6 Luna, and Hermes/Pi on Haiku. Selecting Claude and Codex
requires both `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`; it plans four native sessions.
Claude Code uses its native Anthropic path; a Claude-to-Luna protocol bridge is not included. The default
90-second worker deadline and four-call MCP cap bound each session, including
reconnects. They are not dollar/token caps. No harness retries or model escalation
occur, and a failed first scenario prevents that client's second paid scenario.
Reports include native/MCP receipts and partial usage/cost coverage. Model-backed
compatibility has not yet been validated; the automated runner test uses a
simulated native client without provider calls.

See [live-smoke setup, scoring, limits and evidence](../docs/testing/live-smoke.md).

## Quick start

Use the command at the top of this page. For release verification, run
`node harness/run.mjs run --xhigh --required` after checking the full setup requirements.

The run prints the path to `report.md`. Everything else for that run sits next to it:

```
~/.midbrain-harness/runs/<run-id>/
  candidate.json  run identity (version, git SHA, archive hashes)
  candidate/     preserved tarball, extracted runtime, lockfile, harness snapshot
  home/           the throwaway home the clients used
  logs/           midbrain-*.log at debug level
  evidence/<client>/<scenario>/*.ndjson|*.json   raw client streams, normalized turns, API read-back
  results.json    every cell with checks, prompt, expected outcome, evidence refs
  report.md       matrix + per-cell detail
  isolation.json  real-home tripwire diff (must be empty)
```

## Fast follow-ups and model sweeps

For a quick model comparison without an infrastructure baseline:

```bash
node harness/run.mjs run --model-checks --clients claude,codex,hermes,nanoclaw --concurrency 4 --keep
```

This runs the six-prompt profile below and explicitly marks infrastructure as
unverified. It cannot serve as a baseline or release sign-off. For a sweep, use
`sweep --model-checks --models models.json --parallel-runs 2 --concurrency 4`.
Existing infrastructure failures remain in their original reports.

Prepare a baseline once for the candidate and client versions you want to test:

```bash
node harness/run.mjs run --clients claude,codex,hermes,nanoclaw --mode registry --scenarios s01,s04,s09,s10 --concurrency 4 --keep
```

The baseline must pass clean install, version stability, project isolation,
upgrade, and all applicable client-specific cases. A full successful run also
qualifies. Then point a follow-up at that completed run directory:

```bash
node harness/run.mjs run --follow-up /absolute/path/to/baseline-run --concurrency 4 --keep
```

Follow-ups use six prompts per selected client when two or more clients form a
recall cycle: one combined capture/literal checkpoint, a no-match prompt, an own
fresh-session recall, a cross-client recall, a state update, and a current-state
question. They retain capture, metadata, duplicate, marker, recall, freshness and
priming assertions. They reuse baseline infrastructure evidence; those checks
are labelled as prior evidence and are not counted as new passes or release
sign-off. Fresh homes, credentials, sessions, projects, markers, and logs prevent
prior conversations from contaminating the result. Only prepared executable
installations and the pinned NanoClaw image/source are reused.

Candidate archive/source, harness source, client versions, Node/platform, API
host and PK setting must match. Failed or missing baseline checks stop the run
before model calls. Changing models is allowed. Changing code or client versions
requires a new baseline; follow-ups cannot themselves become baselines.

For multiple model choices, save a JSON file **outside `harness/`** (model data
should not change the frozen harness source), for example `models.json`:

```json
[
  {"name":"fast", "models":{"claude":"claude-haiku-4-5", "codex":"gpt-5.6-sol", "hermes":"claude-haiku-4-5", "nanoclaw":"claude-haiku-4-5"}},
  {"name":"sonnet", "models":{"claude":"claude-sonnet-4-5", "codex":"gpt-5.6-sol", "hermes":"claude-sonnet-4-5", "nanoclaw":"claude-sonnet-4-5"}}
]
```

```bash
node harness/run.mjs sweep --follow-up /absolute/path/to/baseline-run --models models.json --parallel-runs 2 --concurrency 4
```

`--concurrency` is the total client-worker budget across rounds, divided between
`--parallel-runs` (default 1). Sweeps accept up to 10 total workers, with at most
5 per round; ordinary runs still accept 1–5. Use the measured four-worker budget
for shipping runs. Budgets above five are experimental and not recommended yet.
Model-check cross-client reads lock only their reader once the checkpoint is
complete, so all four reads can overlap. Cold capture and infrastructure cases
retain their existing ordering. The default sweep budget remains 4.
Each round runs a representative directed cycle,
not every model combination. A round's failure does not discard the other
rounds; the sweep fails if any round fails or is incomplete. `sweep.json` and
`report.md` record actual elapsed time, prompt counts, models and report links.
The 15-minute target depends on model latency and sweep size; it is not a timeout
that hides unfinished checks. SIGINT/SIGTERM cancel active rounds and their normal
registry/container cleanup still runs.

Measured on 2026-09-10: the two four-client model-check rounds above completed in
**11m 36s**, including cleanup, with `--parallel-runs 2 --concurrency 4` (48 prompts,
113 PASS / 7 FAIL, real-home isolation passed). This was standalone model coverage,
not verified infrastructure reuse. The eight-worker attempt stopped at the local
API probe with HTTP 401 before any prompts, so its speedup is not yet measured.
That probe uses the harness key directly, before isolated client homes are populated;
it is an authentication failure, not evidence of load or client key propagation.
Runs now probe before building the candidate or starting the registry. Readback
stops immediately on HTTP 401/403 and reports BLOCKED rather than waiting for capture.
See the [operator guide](../docs/testing/harness-how-it-works.md#fast-model-checks-and-sweeps)
or its [HTML page](../docs/testing/harness-how-it-works.html#fast-model-checks-and-sweeps)
for the profiles, commands and evidence limits.

## Three-prompt Simple runs and custom experiments

Choose the coverage level (these names do not change the model):

| Flag | Coverage |
|---|---|
| `--simple` | Three prompts per client: capture, fresh-session recall, unrelated answer. |
| `--high` | Previous broad Simple: all scenarios and upgrades, one loop of memory-sharing checks, with shared setup and capture reuse. |
| `--xhigh` | Full coverage: all scenarios and upgrades, memory sharing in both directions between every pair of clients. |

High and XHigh automatically enable registry mode and upgrades. Both accept `--clients`;
coverage applies to the selected clients. Use `run --xhigh --required` for the complete
release gate. Custom `--config` experiments apply to Simple only.

```bash
node harness/run.mjs run --simple --mode registry --clients claude,codex,hermes,nanoclaw --concurrency 4
node harness/run.mjs run --high --clients claude,codex,hermes,nanoclaw --concurrency 4
node harness/run.mjs run --xhigh --clients claude,codex,hermes,nanoclaw --concurrency 4
```

Sweeps also accept `--simple`, `--high` or `--xhigh`, applying that coverage to each
round’s model/client selection. `--required` is only available on `run`.

**Simple = save a fact, recall it in a new session, answer an unrelated question.**
It sends at most three prompts per client. If capture fails, the dependent recall is
BLOCKED without sending a prompt. Tool calls and verification polling add API requests;
three prompts does not mean exactly three HTTP requests.

### Make a custom run: edit one file, run one command

Start with [`harness/examples/simple.json`](examples/simple.json):

```json
{
  "models": {
    "claude": "claude-haiku-4-5",
    "codex": "gpt-5.6-sol",
    "hermes": "claude-haiku-4-5",
    "nanoclaw": "claude-haiku-4-5"
  },
  "prompts": {
    "unrelated": {
      "prompt": "What is the capital of France? Answer in one short sentence.",
      "criteria": { "contains": ["Paris"], "notContains": ["memory_search"] }
    }
  }
}
```

```bash
node harness/run.mjs run --config harness/examples/simple.json --mode registry --concurrency 4
```

That runs the three Simple scenarios on the four listed clients/models. Capture and
recall use built-in prompts; the unrelated question uses your prompt and criteria.
Remove a model entry to omit that client. Change a model name to try another model.
Supported client IDs are `claude`, `codex`, `hermes`, `nanoclaw`, `opencode`, and `pi`.
Credentials stay in `harness/.env` or the environment, never in the config.

### Change only what you need

| Want to change… | Edit… |
|---|---|
| Clients and models | `models`: client ID → model name. Alternatively, `clients` can select clients using their environment/default models. |
| Which tests run | Optional `scenarios`: `["capture", "recall", "unrelated"]` by default. For just your custom question, use `["unrelated"]`. Recall requires capture. |
| A question | `prompts.capture`, `prompts.recall`, or `prompts.unrelated`, each with a `prompt`. Omitted entries use defaults. |
| What passes | `criteria.contains` / `notContains` check final-answer substrings; `memoryContains` checks successful recorded memory evidence. All listed criteria must pass. Matching is case-sensitive. |

Capture/recall templates use `{{marker}}` for the unique task ID and `{{value}}` for the
hidden fact. Capture must include both; recall must include the marker and must **not**
include the hidden value. `{{client}}` inserts the client ID. Capture and recall retain
their built-in storage, fresh-session and evidence checks; custom criteria add to them.
A custom unrelated prompt must specify its own criteria. These are substring checks,
not exact equality or an AI judge: `contains: ["4"]` also matches `"42"`.

Use `MIDBRAIN_HARNESS_CONFIG` instead of `--config` if you prefer environment settings.
Existing `MIDBRAIN_HARNESS_<CLIENT>_MODEL` variables override config model names;
`--clients` overrides the selected clients. The run saves its configuration, selected
models, actual prompts, results, costs and failure traces for debugging.

For multiple model combinations, keep the existing model-rounds JSON and use:

```bash
node harness/run.mjs sweep --simple --models /absolute/path/to/models.json --config harness/examples/simple.json --parallel-runs 2 --concurrency 4
```

Each round supplies its client/model selection; the experiment supplies the prompts and
criteria. Omit `--config` for the built-in questions. Simple excludes upgrades,
cross-client recall, updated-fact reconciliation and special-client cases. Use the full
matrix for those; do not combine Simple with `--upgrade`, `--required` or `--scenarios`.

### How much faster and cheaper?

| Comparable selection | Before | Three-prompt Simple | Prompt reduction |
|---|---:|---:|---:|
| Four clients, two model rounds | 48 planned prompts (six-prompt model checks) | 24 | 50% |
| Four clients, one round | 47 planned prompts (historical broad Simple with upgrades) | 12 | About 74% |

In the completed `20260910-135656-d7cc` sweep, the capture, fresh-session recall and
unrelated-question attempts accounted for **$0.7952** of the **$1.4756** available API
subtotal: **46% lower** when retaining just those attempts. This is an allocation of
historical costs to the retained scenarios, **not a measured run of the new profile**.
The original run attempted 40 of its 48 planned prompts; the retained scenarios account
for 24 attempts, with two NanoClaw launch failures lacking cost records. Amounts mix
reported charges and token-based estimates and exclude runner/backend costs.
Codex's ChatGPT API-equivalent falls separately from $0.6090 to $0.3184; that is not
an extra subscription charge.

**Measured minimized run after repairing the local API:**
`20260910-181234-373c` completed in **4m 37s**, with **12 prompt attempts** across
Claude/Haiku, Codex/gpt-5.6-sol, Hermes/Haiku and NanoClaw/Haiku. The available API subtotal
was **$0.1785**; Codex's **$0.1403 API-equivalent** is separate and is not an extra charge.
Costs were recorded for 11 of 12 attempts; NanoClaw's Docker-failed attempt has no cost
record, so the subtotal is incomplete. Real-home isolation passed.

Original scores: **37 PASS / 3 FAIL / 0 BLOCKED**. Claude returned the correct fact via
a quoted MidBrain result-file path that the original scorer missed; the scorer now
recognizes that path, and the saved report labels the false negative without rewriting
its original verdict. NanoClaw returned similar memories without finding the exact target
and later encountered a Docker inspection timeout. This is a completed diagnostic run,
not an all-green release gate. The earlier two attempts stopped at the 60-second API
preflight with zero prompts, before the core authentication fix and API restart.

The 4m 37s measurement is for **one model combination**, not the two-round sweep.
It is not directly comparable to the earlier 22m 46s two-round run. The prompt reductions
above are exact; runtime and token costs depend on the chosen models, tool use and
service health.


## HTML results, live logs and costs

Completed runs and sweeps also write a standalone `report.html`: timing, models, coverage,
failed checks and per-client cost accounting. Regenerate saved results without model
calls using `node harness/run.mjs report /absolute/path/to/run-or-sweep`.

HTML and Markdown findings name the client, requested model, test, and sweep round.
Cross-client findings name both the client that saved the fact and the client asked to
recall it, with both model pins. Each finding explains the observed problem and next step;
original checks and verdicts remain available as technical evidence. Live scenario failures
use the same explanations. Historical console logs are preserved as recorded.

Capture verification allows 60 seconds per API request and a 3-minute polling budget
(default `--readback-timeout-ms 180000`, also settable with
`MIDBRAIN_HARNESS_READBACK_TIMEOUT_MS`). An in-flight request may finish beyond that
budget. Successful checks finish early; authentication errors still stop immediately.

Console progress includes setup, each scenario and model turn, and a 30-second heartbeat.
Sweeps stream round-prefixed progress live and update `<round>/runner.log` continuously.
Press Ctrl+C to cancel active/queued work and invoke process, container and registry cleanup.
On macOS/Linux, native subprocess groups are terminated together. Cleanup is bounded;
provider work already dispatched can still incur cost.

Costs are saved in `costs.json` and shown in both reports. Reported charges, estimates,
and Codex ChatGPT API-equivalent costs are listed separately. Missing usage is marked;
runner and backend costs are excluded. Regenerating a report updates accounting from
saved usage without sending model prompts.

See the [timing and cost table](../docs/testing/harness-how-it-works.md#cost-and-duration-by-run-type)
for measured runs and their limitations.

## Fully local mode (no MidBrain cloud)

Run the MidBrain API from the `memory` repo on this machine and point the harness at it. The
helper wraps `docker compose up`, seeds two local agents with the repo's dev seed script, and
writes their keys plus `MIDBRAIN_HARNESS_API_URL=http://127.0.0.1:8000` into `harness/.env`
(keys are never printed):

```bash
bash harness/scripts/local-stack.sh up      # build (first time), start, wait for /health
bash harness/scripts/local-stack.sh seed    # mint harness + project agents → harness/.env
bash harness/scripts/local-stack.sh status  # containers + API probe with the harness key
bash harness/scripts/local-stack.sh down    # stop the stack (data persists in memory/volumes)
```

Set `MIDBRAIN_MEMORY_REPO` if the API repo is not at `../memory`. Embeddings and search run
locally (fastembed ColBERT); only the optional dream/chat models need Ollama or Bedrock. After
seeding you still add `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` for the clients themselves.

## Safety

- The private home isolates configuration; it is **not an OS sandbox**. Native clients can
  run commands with your user permissions. Use trusted prompts and test memories, or a
  dedicated machine for untrusted inputs.
- Local reports and traces may contain prompt text, model answers and tool output. Use
  the evidence exporter and review its output before sharing; do not upload a whole run directory.
- Children never see your real `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `MIDBRAIN_*`,
  `ANTHROPIC_*`, `OPENAI_*` or `CI`; the harness builds a scrubbed env and adds only the
  secret each client needs.
- The real home is hashed before and after every run (Vitest tripwire surfaces plus live-client
  surfaces). Any drift fails the run and names the surface, never its contents.
- `doctor` refuses a harness key that matches any key file in the real home, and a run root
  inside the temp dir (the product skips self-repair from tmp).
- Run homes are durable on purpose; delete `~/.midbrain-harness/runs/<id>` when done.

## Adding a client

Add one file in `harness/clients/` exporting a manifest (see `claude.mjs`), register it in
`clients/index.mjs`. The manifest owns install/launch, detection fixtures, secrets, env,
`runTurn` (normalized `Turn`), evidence collection, known exceptions and its client-specific
cases. Scenarios and the report never change.

## Status

Phase 0: Claude Code, Codex, OpenCode (run-local npm install) and Hermes (run-local uv install)
drivers; scenarios S1, S2, S3, S5, S6, S8, S10 (self-repair smoke, cold first turn, Codex hook
trust, Hermes hook acceptance); S9 via `--mode registry --upgrade`; S4 needs a second agent key.
Installer, adapter freshness, registry/upgrade mechanics, OpenCode MCP connection and Hermes hook
consent listing have offline checks. NanoClaw now runs the pinned upstream v2 agent-runner
inside Docker, with native capture and client-specific lifecycle scenarios. See below for prerequisites
and the boundary of this lane; a working driver does not imply every behavioral cell passes.


## NanoClaw

Requires Node **24+**, Git, Docker (Linux or macOS), `ANTHROPIC_API_KEY`, and the dedicated
MidBrain harness key. The first run clones the pinned source and builds its upstream image;
allow several minutes and Docker disk space. No messaging-service login is required.

```bash
node harness/run.mjs doctor --clients nanoclaw
node harness/run.mjs run --clients nanoclaw --scenarios s01,s06
node harness/run.mjs run --clients nanoclaw --mode registry --scenarios s01,s03,s04,s05,s06,s08,s10
node harness/run.mjs run --clients codex,nanoclaw --mode registry --scenarios s02
node harness/run.mjs run --clients nanoclaw --mode registry --upgrade --scenarios s09
```

S4 also requires `MIDBRAIN_HARNESS_PROJECT_API_KEY`. Cross-client S2 requires at least two
runnable clients and their provider credentials. Legacy opener migration (S10) requires
registry mode; dev mode records it as BLOCKED because automatic migration is bypassed in
a temporary dev installation. **FAIL, BLOCKED, an empty run, or real-home drift exits 1**;
PASS and BLOCKED cells with clean isolation exit 0. BLOCKED means incomplete coverage, not a failed run; failed checks still exit 1. Release verification still requires all required checks to pass.

The adapter pins NanoClaw to `6656b326a900dcfba4be8ca76412d954cfc915b5` and records the
source revision, image digest, runner lockfile hash, and candidate identity in `nanoclaw.json`.
It drives the actual Claude provider through NanoClaw's SQLite mailbox. Each turn creates
and removes a container; fresh sessions get a new mailbox and SDK continuation, while resumed
sessions retain their original continuation and durable `.claude-shared` state. The candidate's
installer prepares hooks and the native SDK invokes them. The harness waits for capture; it
never replays hooks. The legacy scenario reconstructs the historical missing-shim/marker
configuration; it is not a historical NanoClaw image or a full previous-release installation.

Linux defaults to Docker host networking to reach the loopback npm registry. Docker Desktop
uses `host.docker.internal`. Custom networks or remote daemons must set reachable API and
registry URLs explicitly (see `.env.example`); bind mounts must resolve to this run on the
Docker host. The model sees the isolated project at `/workspace/agent`, and captures must
report `client=nanoclaw` and that container cwd. No real NanoClaw home or messaging account
is mounted. Provider credentials are supplied through a private env file, and only the test
MCP credential is in the group config. Container logs, redacted provider transcripts, correlated
mailbox snapshots, and API read-back are retained as evidence. Run homes contain credentials
and are private; do not upload whole run homes as CI artifacts.

Named containers are removed on normal completion, failed setup, timeouts, and handled
SIGINT/SIGTERM. SIGKILL or host failure cannot run cleanup; leftover containers are identifiable
by the `dev.midbrain.harness.run` label. Images are cached intentionally for later runs.

This lane covers MCP integration through the real runner. Slack/WhatsApp delivery, host
routing, OneCLI gateway provisioning, and other NanoClaw providers are outside its scope.
The manual workflow is built; runner activation, Linux validation and release enforcement remain separate work.

### Optional self-contained NanoClaw image

Prepare the pinned runner once, without provider keys or model calls:

```bash
mkdir -p "$HOME/.midbrain-harness/packages"
node harness/scripts/prepare-nanoclaw.mjs "$HOME/.midbrain-harness/packages/nanoclaw"
export MIDBRAIN_HARNESS_NANOCLAW_MANIFEST="$HOME/.midbrain-harness/packages/nanoclaw/nanoclaw-image.json"
```

This builds a local image containing the runner source, required host assets and upstream
license. The manifest pins the image ID, revision, platform and asset hashes. With this
variable set, runs use the exact prepared image and do not clone NanoClaw or mount a source
checkout. Unset it to use the existing preparation path. Images must already be present;
the harness does not pull or publish them. The preparation command uses exported environment
overrides, not `harness/.env`.

See the [packaging and transfer instructions](../docs/testing/harness-how-it-works.md#optional-prepare-nanoclaw-once-then-reuse-or-transfer-it)
for `docker save`/`load`, architecture requirements and remaining runtime dependencies.

### Trustworthy runs

`run` builds and preserves a candidate tarball plus its SHA-256, extracted runtime,
source dependency lock, and a copy/hash list of the harness code under `candidate/`.
Dev clients execute that extracted package. Registry mode republishes that same
archive locally (changing only the package version when an RC is necessary).
Every turn saves its exact prompt and checks for changed candidate/harness inputs;
client versions are compared before and after the run. Model choices and client
versions appear in `results.json`; pin the documented environment options when
repeating a run. Provider model behavior itself is not deterministic.

Recall requires hidden values in successful MCP results and the final answer.
Freshness requires an explicit JSON current value. Capture waits for both roles
and five seconds of stability, then compares metadata to the real session.
NanoClaw compares captures against distinct native provider responses, so a second
native response is distinguished from a duplicate capture. Claude capture is
native and synchronous; there is no fallback hook replay.

For the complete required matrix, use `run --xhigh --required`.
This rejects client/scenario subsets. Release evidence verification requires every check to pass; BLOCKED leaves coverage incomplete.
Native Codex hook approval runs automatically on Linux/macOS when its S10 case is selected
(Python 3 and Codex 0.150.1 required). Use `--interactive` for manual terminal approval
instead. The harness first verifies capture is absent, opens Codex for `/hooks` approval,
then verifies capture in a new process without the trust bypass. In manual mode, approve
only the three installed MidBrain hooks and exit with `/quit`. The old
`--approve-codex-hooks` flag is accepted for compatibility but is no longer needed.
Claude cold-first-turn coverage creates a
separate fresh home when the main home has already run an upgrade prelude.

For three prompts per client, add `--simple`:

```bash
node harness/run.mjs run --mode registry --simple
```

To overlap independent clients without reducing coverage, use:

```bash
node harness/run.mjs run --mode registry --simple --concurrency 3
```

`--concurrency` accepts 1–5 (default 1). Ordinary scenarios run up to that many
client jobs at once, including their capture polling and indexing waits. Each
scenario finishes before the next starts; turns inside each job remain sequential.
Cross-client jobs reserve both writer and reader so neither client runs twice at
once, and each writer's checkpoint is still captured and indexed only once.
Disjoint pairs may start out of manifest order; results retain planned job order.
The separate model-check profile uses a five-link cycle and can overlap at most two pairs at a time. Simple has no cross-client links.

Installation, the upgrade prelude, S1 cold capture, and S10 configuration/repair
cases remain serial. S4 clients all await one project installation before their
turns begin. New scenarios are serial unless explicitly marked parallel-safe.
The report, partial/final JSON and exported evidence record the concurrency limit.
Use `--concurrency 1` for serial troubleshooting; higher concurrency can encounter
provider rate limits. Prompt counts and pass/fail checks are unchanged.

Simple omits cross-client links, upgrades and client-specific repair cases. The separate
six-prompt model-check profile and High use one directed cycle; XHigh checks all ordered pairs.
The reduced three-prompt profile is not release sign-off. Older broad Simple timing
measurements below predate this change and do not measure the current Simple profile.

Live validation on 2026-09-10 (`20260910-082009-e52c`, all five clients,
`--mode registry --upgrade --simple --concurrency 3`, using the former broad Simple profile) completed in 33m 52s:
87 PASS, 7 FAIL, and no real-home drift. The parallel stages took 15m 57s for
31m 54s of combined job time; the log showed at most three jobs and no
overlapping jobs for the same client. This is measured overlap, not a separate
serial benchmark. The failures concern freshness/priming, previous-release
Claude assistant capture, and OpenCode plugin-only assistant capture; this run
is not passing release evidence.
A focused Claude capture/freshness control with `--concurrency 1` subsequently
passed all nine checks (`20260910-085437-8e83`); the full-run failures remain recorded.

NanoClaw retains a per-group npm cache populated by its installer. Deployments
using ephemeral homes need the same durable cache mount (`/home/node/.npm`) to
avoid simultaneous cold npm installs by MCP and capture hooks. Upgrade validation
explicitly clears each group's `_npx` resolution cache before checking the new version.
Hermes acceptance, OpenCode capture without MCP, Claude hook order, and NanoClaw
lifecycle have explicit cases. The manual workflow below still needs runner provisioning and live validation.

## Export release evidence

After a run finishes, export a review directory outside the private run home:

```bash
node harness/scripts/release-evidence.mjs export /path/to/completed-run /path/to/new-bundle
node harness/scripts/release-evidence.mjs verify /path/to/new-bundle /path/to/release.tgz FULL_SOURCE_SHA
```

The standalone exporter does not run clients or alter the original run. It writes a
regenerated report, redacted results/candidate identity, selected normalized evidence,
and a manifest of SHA-256 checksums. Credentials, raw transcripts, databases, installer
logs and package archives stay private. Exact prompts, tool calls/results, API readbacks
and the native approval receipt are included when available. Inspect the bundle before
sharing; redaction handles known secrets and common patterns, not arbitrary sensitive text.
Upload this directory as a workflow artifact, or archive the directory for manual sharing.

Export exit 0 means the bundle was created. Failed/focused/dirty-source runs are useful
**checkpoints** and can be exported. Verification exits 0 only for a complete passing
required matrix with clean isolation, recorded model/client versions, matching checksums,
and the supplied full source SHA and exact release archive. An RC-version rewrite changes
the archive hash; a differently versioned repack cannot inherit the old report's sign-off.
Verification does not replace programmatic CI or Radu's review, and checksums are not signatures.

Do not export `results.partial.json` or treat an interruption report as a completed run.
The [coverage map](../docs/testing/multi-client-harness.md#5-behavioral-coverage-and-prompt-ownership)
distinguishes current checks from unvalidated or missing coverage. Follow the
[release validation checklist](../docs/releases/README.md#release-validation-checklist).

## GitHub Actions

A manual [behavioral workflow](../.github/workflows/behavioral.yml) is implemented with
smoke/simple/high/xhigh/required suites, pinned models/clients, selected artifacts and scoped cleanup.
It has not been deployed or run in the cloud. See [runner and secret setup](../docs/testing/behavioral-ci.md).
The required suite automates native Codex hook approval and retains the before/after capture proof.
Native approval automation is implemented; a full unattended Linux run still needs validation.
