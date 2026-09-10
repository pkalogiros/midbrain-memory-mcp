# Multi-client behavioral harness

Launches **real** client sessions (Claude Code, Codex, OpenCode, Hermes, and NanoClaw) inside a throwaway home, lets the product's own installer configure them against a
frozen candidate, drives frozen prompts, and scores raw evidence (API read-back, tool calls,
hook logs) into a side-by-side parity report. Design: `docs/testing/multi-client-harness.md`.

Start with the [architecture and operator guide](../docs/testing/harness-how-it-works.md)
for diagrams, the file map, setup and run recipes, results parsing, and release evidence.
An [offline HTML edition](../docs/testing/harness-how-it-works.html) includes the complete
guide and embedded diagrams in one shareable file; open it directly in a browser.

Pi support is also a product change: the published package includes its adapter,
extension and installer detection. Only its harness selection is opt-in. Include
Pi in the release notes and product review; it is not merely a test driver.

Pi is available explicitly with `--clients pi` or, for cross-client recall,
`--clients claude,pi`. The existing five-client default and required release
matrix are unchanged. Pi is installed under the run's tools directory using
`@earendil-works/pi-coding-agent`; set `MIDBRAIN_HARNESS_PI_VERSION` to pin it and
`MIDBRAIN_HARNESS_PI_MODEL` to choose an Anthropic model (default
`claude-haiku-4-5`). It uses the dedicated harness `ANTHROPIC_API_KEY`.

```bash
node harness/run.mjs run --clients pi --scenarios s01,s03,s06 --mode registry --keep
node harness/run.mjs run --clients claude,pi --scenarios s01,s02 --simple --mode registry --keep
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

## Quick start (this machine)

```bash
cp harness/.env.example harness/.env   # fill in the keys
node harness/run.mjs doctor            # clients, secrets, API probe, run root
node harness/run.mjs run --clients claude,codex --scenarios s01,s06   # smoke
node harness/run.mjs run --clients claude,codex                        # full matrix, dev mode
node harness/run.mjs run --clients claude,codex --mode registry        # exact tarball via loopback npm registry
node harness/run.mjs run --clients claude,codex --mode registry --upgrade   # previous release → candidate (S9)
```

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
node harness/run.mjs run --clients claude,codex,hermes,nanoclaw --mode registry --upgrade --simple --scenarios s01,s04,s09,s10 --concurrency 4 --keep
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

The new four-client/two-round sweep `20260910-135656-d7cc` took **22m 46s**
with four workers: **87 PASS / 17 FAIL / 16 BLOCKED**. Both real-home isolation checks
passed. Of 48 planned prompts, 40 were attempted and 38 returned turn records;
API readback failures prevented the eight final freshness questions. This is a failed
model-check run, not release sign-off or a passing speed benchmark.

| Client | Reported USD | Estimated USD | ChatGPT API-equivalent USD | Accounting |
|---|---|---|---|---|
| claude | $0.248139 | $0.079174 | $0.000000 | 10/10 attempts; 2 interrupted estimates may omit auxiliary usage |
| codex | $0.000000 | $0.000000 | $0.609012 | 10/10 attempts |
| hermes | $0.000000 | $0.698991 | $0.000000 | 10/10 attempts |
| nanoclaw | $0.000000 | $0.449287 | $0.000000 | 8/10 attempts; Docker launch failures have no model usage record |

**Available API subtotal: $1.475591** ($0.248139 reported + $1.227451 estimated). Codex adds **$0.609012 API-equivalent**, recorded separately because this run used ChatGPT authentication.

This is not a complete invoice: two NanoClaw launch attempts have no usage record,
and two interrupted Claude estimates may omit unreported auxiliary work. All 38
returned turn records have either reported costs, estimates or plan equivalents.
Runner and MidBrain backend costs remain unmetered. The early host load exceeded 180;
the run also recorded Docker launch failures, native hook timeouts, a Codex TLS
reconnection error, two five-minute Claude timeouts and API readback failures.
These observed conditions limit the timing comparison; no failures were erased.

| Round | Available API subtotal | Codex API-equivalent | Time |
|---|---|---|---|
| fast | $0.385836 | $0.293879 | 22m 29s |
| sonnet | $1.089755 | $0.315133 | 22m 46s |

`costs.json` and the refreshed Markdown/HTML reports contain the reconciled accounting.
The original `results.json` and `sweep.json` are retained unchanged; their cost fields
predate recovery of interrupted Claude usage and inclusion of failed launch attempts.
Regenerating reports reads the saved native usage and updates `costs.json` without model calls.

The earlier 11m 36s sweep `20260910-101821-a704` remains historical evidence:
113 PASS / 7 FAIL and only $0.42764350 of Claude costs recorded. Its subtotal is
not comparable to this fuller four-client accounting. Neither run proves a passing
15-minute sweep. Parallelism alone does not guarantee lower provider spend.

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

For the complete required matrix, use `run --mode registry --upgrade --required`.
This rejects client/scenario subsets; FAIL, BLOCKED, and SKIP all exit nonzero.
Native Codex hook approval runs automatically on Linux/macOS when its S10 case is selected
(Python 3 and Codex 0.150.1 required). Use `--interactive` for manual terminal approval
instead. The harness first verifies capture is absent, opens Codex for `/hooks` approval,
then verifies capture in a new process without the trust bypass. In manual mode, approve
only the three installed MidBrain hooks and exit with `/quit`. The old
`--approve-codex-hooks` flag is accepted for compatibility but is no longer needed.
Claude cold-first-turn coverage creates a
separate fresh home when the main home has already run an upgrade prelude.

For a smaller run that retains the other scenarios, add `--simple`:

```bash
node harness/run.mjs run --mode registry --upgrade --simple
```

To overlap independent clients without reducing coverage, use:

```bash
node harness/run.mjs run --mode registry --upgrade --simple --concurrency 3
```

`--concurrency` accepts 1–5 (default 1). Ordinary scenarios run up to that many
client jobs at once, including their capture polling and indexing waits. Each
scenario finishes before the next starts; turns inside each job remain sequential.
Cross-client jobs reserve both writer and reader so neither client runs twice at
once, and each writer's checkpoint is still captured and indexed only once.
Disjoint pairs may start out of manifest order; results retain planned job order.
The five-link simple cycle can overlap at most two pairs at a time.

Installation, the upgrade prelude, S1 cold capture, and S10 configuration/repair
cases remain serial. S4 clients all await one project installation before their
turns begin. New scenarios are serial unless explicitly marked parallel-safe.
The report, partial/final JSON and exported evidence record the concurrency limit.
Use `--concurrency 1` for serial troubleshooting; higher concurrency can encounter
provider rate limits. Prompt counts and pass/fail checks are unchanged.

Cross-client recall follows one cycle in manifest order:
OpenCode → Claude → Codex → Hermes → NanoClaw → OpenCode. Every client writes once
and reads once. Simple reuses the S1 checkpoint, so S2 uses five pairs / five new reader prompts instead of twenty pairs / twenty-five prompts in Full mode. In every mode a writer stores one checkpoint that all of its readers read, so the
full matrix costs five writes plus twenty reads, not forty prompts, and the indexing grace is
paid once per writer. All other selected scenarios and their pass/fail checks are unchanged;
the savings apply to cross-client recall, not the entire bill.

Four more turns are scored from existing evidence rather than repeated, and each cell says
so in its notes: in upgrade mode S1 scores the prelude's post-upgrade capture (the first
candidate session, same prompt and project); Claude's hook-ordering case is derived from S1's
native read-back timestamps; S4 reuses S1's global-credential write from proj-a as its global
marker (the leak check spans the S1 write); and in simple mode only, S3 is scored on the
prelude's checkpoint write and fresh-session recall on the candidate instead of two more
prompts. Simple mode also leaves two required-only checks to `--required`: S4's global
recall from a directory that never saw the installer (proj-a already proves global-credential
recall) and Codex persisted hook approval. Three more simple-only reuses: S5 treats the
client's own S2 checkpoint as the stale state (only the update and the ask are new prompts),
OpenCode's plugin-only case stops at the verified capture (recall is covered by S2/S3), and
Hermes' accepted-hooks half is S1's own capture. Required mode keeps all of them explicit. A
full five-client upgrade matrix is 107 planned prompts. Simple now reuses S1’s hidden-value/literal checkpoint for S2 and S8: 58 planned prompts (68 before this reuse; both include Claude’s cold-home probe), with the same assertions. Without upgrades, S3 also reuses that checkpoint. For the four-client Claude/Codex/Hermes/NanoClaw selection, Simple with upgrades plans 47 prompts instead of 55. This saves two prompts per client with upgrades, three without; actual counts vary with selected clients and blocked prerequisites.

Client subsets form a cycle in the same stable order; at least two clients are needed
for cross-client recall. Unavailable clients keep their place and affected links are
BLOCKED. `results.json`, the report and exported evidence record simple mode and the
planned links. A passing simple run is reduced-coverage validation, not full required
sign-off. `--simple --required` is rejected; omit `--simple` for all ordered pairs.
Live validation on 2026-09-10 (`20260910-082009-e52c`, all five clients,
`--mode registry --upgrade --simple --concurrency 3`) completed in 33m 52s:
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
smoke/simple/required suites, pinned models/clients, selected artifacts and scoped cleanup.
It has not been deployed or run in the cloud. See [runner and secret setup](../docs/testing/behavioral-ci.md).
The required suite automates native Codex hook approval and retains the before/after capture proof.
Native approval automation is implemented; a full unattended Linux run still needs validation.
