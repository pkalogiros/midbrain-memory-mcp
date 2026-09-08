# Multi-client behavioral harness

Launches **real** client sessions (Claude Code, Codex; OpenCode, Hermes, NanoClaw in later
phases) inside a throwaway home, lets the product's own installer configure them against a
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
  candidate.json  run identity (version, git SHA, npm pack integrity)
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
consent listing were verified offline (no model calls yet). NanoClaw reports BLOCKED (needs Docker
and a NanoClaw checkout; phase 3).
