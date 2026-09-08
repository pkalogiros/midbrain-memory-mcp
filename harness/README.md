# Multi-client behavioral harness

Launches **real** client sessions (Claude Code, Codex, OpenCode, Hermes, and NanoClaw) inside a throwaway home, lets the product's own installer configure them against a
frozen candidate, drives frozen prompts, and scores raw evidence (API read-back, tool calls,
hook logs) into a side-by-side parity report. Design: `docs/testing/multi-client-harness.md`.

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
only PASS cells with clean isolation exit 0.

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
Behavioral CI/release wiring remains separate work.

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
Add `--interactive` when running in a terminal to complete Codex persisted hook
approval. The harness first verifies capture is absent, opens Codex for `/hooks`
approval, then verifies capture in a new process without the trust bypass. Approve
only the three installed MidBrain hooks and exit with `/quit`. Without this flag,
the approval cell remains BLOCKED. Claude cold-first-turn coverage creates a
separate fresh home when the main home has already run an upgrade prelude.

NanoClaw retains a per-group npm cache populated by its installer. Deployments
using ephemeral homes need the same durable cache mount (`/home/node/.npm`) to
avoid simultaneous cold npm installs by MCP and capture hooks. Upgrade validation
explicitly clears each group's `_npx` resolution cache before checking the new version.
Hermes acceptance, OpenCode capture without MCP, Claude hook order, and NanoClaw
lifecycle have explicit cases. CI/release integration remains separate work.
