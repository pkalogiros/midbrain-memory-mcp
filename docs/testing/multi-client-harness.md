# Multi-Client MCP Testing Harness — Design

Status: implementation and remaining release work (2026-09-08). Owner: Pantelis (operations). Reviewer: Radu (technical).
Baseline: `origin/main` = v0.4.10 (`b09f9f6`), 49 Vitest files / 1,237 cases, CI matrix ubuntu + windows + macos.

This document turns the "multi-client MCP testing overview" into a concrete pipeline
that lives in this repository under `harness/`. It is written against the code as it
exists today; every path, env var, and hook name below was verified in source.

---

## 1. Goal and definition of done

A release candidate has **feature parity** when it passes two lanes on the **same frozen
candidate**:

| Lane | Proves | Mechanism | Exists today? |
|---|---|---|---|
| Programmatic | package, installer, hooks, config, credentials, self-repair, capture and recovery paths behave deterministically | Vitest suite + gate scripts + OS matrix | Yes (see §3) |
| Behavioral | real agents in real clients capture, recall, continue, reconcile, stay clean on no-match, and read memory written by other clients | `harness/` launches real client sessions and scores raw evidence | **No** — this is the deliverable |

Parity is asserted at three levels: package parity (OS matrix), client-integration parity
(tools exposed, scope resolved, events captured, metadata correct, self-repair safe), and
behavioral parity (agents actually use MidBrain correctly). Clients may use different
mechanisms; only the observable outcomes must match.

## 2. What already exists and is reused, not rebuilt

| Existing piece | Location | Reused for |
|---|---|---|
| Client adapters (`id`, `isInstalled`, `installGlobal`, `installProject`, `isFresh`, `repair*`) | `shared/clients/{base,registry,claude,codex,hermes,nanoclaw,opencode}.mjs` | The harness manifests wrap these; install goes through the real installer, never a parallel implementation |
| Throwaway-home fixture + managed env key list | `tests/helpers/test-env.mjs` (`makeTestEnv`, `MANAGED_ENV_KEYS`, `sandboxPaths`) | Env scrubbing list and detection-fixture recipe |
| Real-home tripwire (hash-before / hash-after on enumerated real config surfaces) | `tests/helpers/global-tripwire.mjs` (`tripwireSurfaces`, `collectHashes`, `diffHashes`) | Imported directly; extended with live-client surfaces (§6.4) |
| Fetch-log preload and loopback HTTP stub patterns | `tests/claude-shim-e2e.test.mjs`, `tests/api-host-parity.e2e.test.mjs` | Optional offline mode for capture assertions without the real API |
| Episodic read-back endpoint | `shared/midbrain-api.mjs` `GET /api/v1/memories/episodic?page&limit&start_date&end_date` → `{items:[{role,text,occurred_at,memory_metadata}]}` | Primary evidence source for capture and metadata |
| Diagnostics report | `shared/diagnostics.mjs` (`pending_entries`, `cache_location`, `capture_log`, probe) | Cheap health collector per client |
| Managed rules block + per-client deferred-tool adapters | `shared/agent-rules.mjs` | Compliance assertions (§5, S7) |

Key facts that shape the harness (all verified):

- **There is no `--client` flag.** The installer configures whatever `detectClients()` finds,
  and detection is pure filesystem presence (`~/.claude.json` or `~/.claude/settings.json`;
  `~/.codex/`; `~/.config/opencode/`; `$HERMES_HOME` or `~/.hermes/`; a NanoClaw root with
  `container/Dockerfile` and `.claude/skills/`). The harness selects clients by planting
  exactly those fixtures in the throwaway home.
- **Self-repair is silently skipped** when the running package is classified `tmp`, `worktree`
  or `ci` (`shared/install-context.mjs`). `_npx` outranks those. Therefore run homes live
  outside `os.tmpdir()` and `/tmp`, `CI` is unset in every child env, and the candidate
  checkout is a normal clone (not a linked worktree).
- **Client identity reaches the MCP server only through `MIDBRAIN_CLIENT`** written into each
  client's MCP entry; the capture label is `MIDBRAIN_CAPTURE_CLIENT` → `~/.claude/.midbrain-capture-client` → adapter id.
- **Capture payload on the wire** is `{ text, role, memory_metadata:{ client, cwd?, session_id? } }`.
  There is no marker, hash, or client timestamp; `occurred_at` is server-assigned. Filtering
  read-back rows is done client-side on `memory_metadata` and on the run marker inside `text`.
- **Codex is the only client with a tool-event hook** (`PostToolUse`); it is posted as an
  assistant-role "Tool activity summary" text, not a distinct role.
- **No uninstall path exists** in the product. "Uninstall idempotency" cannot be tested until one does.
- **Claude Code print mode** (`claude -p … --output-format stream-json`) fires
  `UserPromptSubmit`/`Stop` hooks, honours `CLAUDE_CONFIG_DIR`, emits `tool_use`/`tool_result`
  blocks for MCP calls, and supports `--session-id` + `--resume`. The harness must **not** pass
  `--strict-mcp-config`/`--bare`: the product's own installer is what configures the home.
- **Codex** supports `codex exec --json … -o <last-message>`, `codex exec resume <id> <prompt>`,
  `CODEX_HOME`, `features.hooks` (stable, enabled here), and `--dangerously-bypass-hook-trust`
  for automation. Hook trust and project trust are the "Codex approval and trust" client case.

## 3. Programmatic lane (coverage map and gaps)

Existing coverage, by the checklist in the overview:

| Checklist item | Covered by | Gap |
|---|---|---|
| Clean global / project install | `install.test.mjs`, `client-*.test.mjs`, `self-repair-safety.test.mjs` | — |
| Upgrade from previous published version | `install.test.mjs` (update check, npx cache clear), `api-host-migration`, `hook-ownership`, NanoClaw cold-upgrade e2e | **No test installs a previously published tarball and upgrades through `npx …@latest`** → harness registry mode (§7) |
| Manual + startup self-repair | `self-repair-safety`, `hostile-home`, `shim-freshness`, `nanoclaw-topology.e2e`, `cache-boot-drain` | — |
| Credential precedence, API host binding | `client-base`, `credential-*`, `keystore`, `api-host*`, `mcp-api-host` | — |
| Per-client config formats | `client-{claude,codex,hermes,opencode,nanoclaw}` | — |
| Tool registration / schemas | `mcp.test.mjs` only | thin, but exact (12 tools, exact names, schemas) |
| User / assistant / tool capture | `claude-shim-e2e`, `codex-hooks`, `hermes-hooks`, `client-opencode-runtime`, `nanoclaw-topology.e2e` | shim/plugin driven, never a real client process |
| cwd / session metadata | `capture-metadata`, runtime tests | — |
| Duplicate / missing capture | `claude-opener-recovery`, `claude-spool`, `cache-boot-drain`, e2e | — |
| Offline cache / spool recovery, races | `episodic-cache`, `claude-spool`, `flush-runner`, e2e | — |
| Package contents / exact version | `docs-regression` (`npm pack --dry-run`), `check-pinned-spec.sh` | — |
| Host isolation | `global-tripwire`, `env-isolation`, `credential-isolation`, `check-test-isolation.sh` | tripwire never validated against a **live** client mutating config → §6.4 |
| Uninstall idempotency | — | **no uninstall exists in the product** |
| Windows shim chain e2e | — | all spawn-based e2e are `skipIf(IS_WIN)` |

The programmatic lane in the pipeline is therefore: `npm run check` (build, lint, tests,
pinned-spec, test-isolation) on the OS matrix, plus `npm pack` identity, plus the harness's
own post-install assertions per client (config files present, hooks/plugins fresh, shim fresh,
tool list = 12, MCP server connected). Nothing here requires new Vitest files on day one.

## 4. Behavioral lane — architecture

```
harness/
  run.mjs                 CLI: doctor | freeze | run | report
  lib/
    env.mjs               .env loading, secret presence (never printed)
    context.mjs           run id, run marker, run dirs, scrubbed child env
    candidate.mjs         freeze: preserved tarball, extracted runtime, dependency lock, harness hashes
    home.mjs              throwaway home, detection fixtures, global key, real installer invocation
    tripwire.mjs          real-home snapshot / verify (wraps tests/helpers/global-tripwire.mjs)
    proc.mjs              spawn with timeout + NDJSON capture
    api.mjs               MidBrain read-back (episodic since run start, polling)
    evidence.mjs          transcripts, midbrain logs, cache/spool counts, codex turn dirs
    checks.mjs            deterministic check helpers, cell status rules
    report.mjs            report.md (side-by-side matrix) + report.json
  clients/
    index.mjs             manifest registry
    claude.mjs codex.mjs opencode.mjs hermes.mjs nanoclaw.mjs
  scenarios/
    index.mjs             ordered scenario registry + report-row mapping
    s01-capture.mjs … s10-client-specific.mjs
```

The harness is a plain Node CLI, **not** a Vitest suite: Vitest's 5 s default timeout,
worker isolation, and the `VITEST`-triggered credential-write guard are wrong for
multi-minute real sessions. The programmatic lane stays in Vitest.

### 4.1 Client manifest (the extension point)

Adding a client means adding one file in `harness/clients/` and nothing in `lib/` or
`scenarios/`. A manifest declares:

```js
export default {
  id: 'claude',                       // must equal the shared/clients adapter id
  displayName: 'Claude Code',
  os: ['darwin', 'linux', 'win32'],
  binary: 'claude',
  install: { kind: 'preinstalled' },  // or { kind:'npm', pkg:'opencode-ai', version } / { kind:'uv-tool', pkg:'hermes-agent' } / { kind:'docker' }
  requiredSecrets: ['ANTHROPIC_API_KEY'],
  detectionFixtures: [{ path: '.claude/settings.json', content: '{}' }],
  configShape: ['~/.claude.json#mcpServers', '~/.claude/settings.json#hooks', '~/.midbrain/bin/claude-hook'],
  mechanism: 'settings.json hooks UserPromptSubmit→user, Stop→assistant(synchronous) + mcpServers',
  expectedCaptureLabel: 'claude',
  capabilities: { userCapture:true, assistantCapture:true, toolCapture:false, sessionResume:true, deferredTools:true },
  knownExceptions: [ '…' ],           // rendered verbatim in the report
  clientEnv(ctx) { … },               // CLAUDE_CONFIG_DIR, secrets
  async version(ctx) { … },
  async runTurn({ ctx, project, prompt, sessionId, resume }) { … }, // → Turn
  async evidence(ctx) { … },          // extra files to copy into the bundle
  specific: [ /* client-specific scenario cells, S10 */ ],
}
```

`Turn` is the normalized session result every scenario scores against:

```
{ client, sessionId, prompt, finalText, toolCalls:[{ name, input, result, ok }],
  init:{ mcpServers:[…], tools:[…] } | null, exitCode, durationMs, rawPath }
```

### 4.2 Session drivers per client

| Client | Launch | Session identity | Raw evidence |
|---|---|---|---|
| Claude Code | `claude -p <prompt> --output-format stream-json --verbose --session-id <uuid>`; fresh session = new uuid; continued = `--resume <uuid>` | `session_id` in Stop payload = the uuid | stream-json NDJSON (`system/init` lists MCP servers + tools; `assistant`/`user` messages carry `tool_use`/`tool_result`; `result` carries final text); transcript `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<uuid>.jsonl` |
| Codex | `codex exec --json --skip-git-repo-check -C <project> -o <file> [--dangerously-bypass-hook-trust] <prompt>`; continued = `codex exec resume <thread> <prompt>` | `thread.started.thread_id` | JSONL items (`mcp_tool_call`, `agent_message`, `command_execution`); `$TMPDIR/midbrain-codex-{assistant-turns,tool-events}/<session>/<turn>/` receipts |
| OpenCode | run-local install of `opencode-ai` into `<run>/tools`; `opencode run --format json --dir <project> [-s <session>]`; `opencode mcp list` proves the MCP connection without a model call | session id present on every JSON event | `opencode export <sessionID>` (messages + parts incl. tool state); plugin log `midbrain-opencode.log`; sqlite db |
| Hermes | run-local `uv tool install 'hermes-agent[mcp]'`; `hermes chat -q <prompt> -Q --provider anthropic -m <model> [--resume <id>]` with `HERMES_ACCEPT_HOOKS=1`; `hermes hooks list` shows consent state, `hermes mcp list` the server | session id from `-Q` output or `hermes sessions list` | `hermes sessions export --format jsonl`; `shell-hooks-allowlist.json`; `midbrain-hermes.log` |
| NanoClaw | Docker required; group container with `.claude-shared/settings.json` merge (driver: phase 3) | Stop payload `session_id` | transcript under `/home/node/.claude/projects`, spool/receipt files |

Hermes's run-owned config sets `mcp_discovery_timeout: 30` so cold npx startup
can finish before its first tool snapshot (Hermes 0.19 defaults to 1.5 seconds).
The export reader accepts nested session envelopes and flat JSONL messages;
only the current turn's successful tool calls count as recall evidence.

OpenCode uses its current-turn JSON stream for answers and tool calls; session
exports remain supporting artifacts. When native MCP metadata identifies a truncated
response, the adapter retains the complete file from the run's OpenCode tool-output
directory for scoring. A truncated export cannot erase current-turn evidence or
credit calls from an earlier resumed turn.

Cold-first-turn coverage requires a separate clean-home run without `--upgrade`.
An upgrade prelude has already started client sessions before S1, so that case
is reported as blocked rather than credited as a cold start.

All children receive a **scrubbed env**: `HOME`/`USERPROFILE` → run home; `TMPDIR`/`TEMP`/`TMP`
→ `<run>/tmp`; `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `HERMES_HOME`, `npm_config_cache` inside the
run home; `MIDBRAIN_LOG_DIR=<run>/logs`, `MIDBRAIN_LOG_LEVEL=debug`; **deleted**: `CI`,
`VITEST`, every `MIDBRAIN_*`, `ANTHROPIC_*`, `OPENAI_*`, `CLAUDE_*`/`CLAUDECODE`, `XDG_*`,
`NANOCLAW_HOME`; then the manifest adds only its own secret(s). `PATH` is the host PATH with
`<run>/tools/bin` prepended.

### 4.3 Run identity, homes, and projects

- One **run** = one run id, one **run marker** `MBH-<6 hex>`, one throwaway home shared by all
  selected clients (mirrors a real user machine and exercises cross-client convergence), two
  project dirs `proj-a` and `proj-b` (each with a `.git` so project rules can be written), and
  one evidence bundle. `--isolated-homes` gives each client its own home when triaging.
- Run root defaults to `~/.midbrain-harness/runs/<run-id>/` (durable, outside tmp, outside the
  repo so lint and Vitest never see it). Override with `MIDBRAIN_HARNESS_ROOT`.
- Every prompt embeds a **sub-marker** `MBH-xxxxxx-<client>-<scenario>[-<n>]` so read-back can
  attribute rows without relying on timing.
- Test identity: `MIDBRAIN_HARNESS_API_KEY` (a dedicated MidBrain agent, never a personal key).
  **Fully local option (verified 2026-09-07):** run the API from the `memory` repo with
  `docker compose`, mint agents with `memory.scripts.dev_seed_agent` (no Cognito needed) and set
  `MIDBRAIN_HARNESS_API_URL=http://127.0.0.1:8000`; `harness/scripts/local-stack.sh` automates it.
  Embeddings and search are local (fastembed ColBERT), so capture and recall work offline from the
  cloud. The repo's Dockerfile needed an arch-neutral `libatomic`/Prisma-engine fix to build on arm64.
  Doctor refuses to run if it hash-matches any key file in the real home. Optional
  `MIDBRAIN_HARNESS_PROJECT_API_KEY` (second agent) enables S4. Optional
  `MIDBRAIN_HARNESS_API_URL` targets a stage API.
- Install path: the global key is written to `<home>/.config/midbrain/.midbrain-key` (0600) as
  a logged-in user would have it, then the **real installer** runs:
  `node <candidate>/install.mjs --dev --non-interactive --no-login` (dev mode) or
  `npx -y midbrain-memory-mcp@latest install --non-interactive --no-login` (registry mode).

## 5. Behavioral scenarios (frozen prompts, expected outcomes, checks)

Prompts below are **drafts** until the maintainer's manual scenario notes are supplied; the
structure and checks are final. `M` = sub-marker. All checks are deterministic; no LLM judge.

| # | Scenario | Kind | Prompt (draft) | Expected raw evidence | Report rows |
|---|---|---|---|---|---|
| S1 | Capture | single | "Please remember this exactly: the harness marker for this session is `M`. Reply with just the marker." | Within ≤90 s the API returns exactly one `user` row and ≥1 `assistant` row containing `M`; both have `memory_metadata.client` = expected label, a `session_id` matching the real client session and the exact client workspace `cwd`. Capture counts settle for five seconds and match native responses. Zero rows with `M` from any other client. | User capture, Assistant capture, Metadata, Duplicates and missing turns |
| S2 | Cross-client recall | directed pair A→B | A: S1 prompt. B (fresh): "Search your MidBrain memory for the token `M` and tell me the exact token and which client recorded it. Do not guess; say not found if it is not there." | B's turn contains ≥1 midbrain tool call whose input contains `M` verbatim; B's final text contains `M`. | Cross-client recall (credited to B) |
| S3 | Fresh-session continuity | single | Session 1: "We are working on task `M`. Checkpoint: the next step is to rename `alpha_<h>` to `beta_<h>` in utils.py. Acknowledge briefly." Session 2 (new session id, same client, same project): "Use memory to find the checkpoint for task `M` and tell me the exact next step, quoting the function names." | Session 2 has a successful MidBrain result containing both hidden function names and reports them in its answer; its session ID differs from session 1. | Fresh-session continuity |
| S4 | Global vs project isolation | single | Write `M` from `proj-b` (project key = second agent). Ask from `proj-a` (global key) → expect *not found*; ask from `proj-b` → expect found. Write `M2` from `proj-a`; ask from `proj-b` → not found (project key isolates); ask from a third global-only cwd → found (global fallback). | Tool calls present in every ask; found/not-found matches the table. | Project and global isolation |
| S5 | Freshness and reconciliation | single | T1: "Note for task `M`: the deploy target is currently `staging-1`." T2 (new session): "Update for task `M`: the deploy target changed to `prod-7`; `staging-1` is retired." T3 (new session): "What is the current deploy target for task `M`? Cite the evidence." | Targets are randomized per run. T3 returns JSON with the exact `current` target and an `evidence` explanation; the current hidden value also appears in a successful MidBrain result. | Freshness reconciliation |
| S6 | No-match cleanliness | single | "What is the capital of Australia? Answer in one short sentence." | Final text contains "Canberra"; contains none of: /midbrain/i, `memory_search`, `check_session_status`, /episodic/i, /not found after search/i, any `MBH-`. Tool-call count recorded as info. | No-match clean |
| S7 | Rule and priming compliance | derived from S2/S3/S5 | — | First tool call of a recall turn is a midbrain discovery/search (Claude: `ToolSearch` then `mcp__midbrain-memory__*`; Codex/OpenCode: visible MCP call), not a shell/file tool; the marker appears verbatim in the query (anchor preservation); if the first search returned no hit, a follow-up search used `limit ≥ 50` or a different surface (search deeper). | Rule and priming compliance |
| S8 | Marker and prompt robustness | single | "Echo the following line back exactly, then say done: `<!-- mb:ctx-start --> midbrain-memory-rules:start MBH-LITERAL-TEST`" | Final text contains the literal line intact; captured `user` row contains it intact (unsigned marker-like text is not scrubbed). | Marker and prompt robustness |
| S9 | Upgrade continuity | run-level | Registry mode only: install previous published version from the loopback registry, run S1, publish candidate as `latest`, clear npx cache as the product does, run S1 + S2 again in existing and fresh sessions. | The client resolves the candidate version; a hidden pre-upgrade value appears in successful MCP evidence and the final answer; new capture lands and adapter freshness passes. | Upgrade and self-repair |
| S10 | Client-specific | per manifest | Claude + Codex: cold first turn captured (S1 is the first turn ever in the home) + stale shim (exec bit stripped in dev mode, body appended in registry mode) repaired by the next session's startup self-repair with the assistant capture landing; the opening user hook may race repair, which is the documented first-hook race. Codex: hooks with persisted trust vs `--dangerously-bypass-hook-trust`; untrusted project dir. Hermes: hook prompt vs `hooks_auto_accept`. OpenCode: capture with the MCP entry disabled, then hidden-value recall from a fresh process with MCP restored. NanoClaw: cold wake with env-stripped hook child; legacy opener recovery. | As stated per cell. | Client-specific scenarios |

PK same-turn injection is added as an extra column set only when
`MIDBRAIN_HARNESS_PK=1` sets `MIDBRAIN_ENABLE_PK_INJECTION=1` in the hook env (product default off).

### 5.1 Cell status rules

- **PASS**: every check in the cell true.
- **FAIL**: any check false.
- **BLOCKED**: prerequisite missing (client binary absent, secret absent, Docker down, registry mode not enabled, driver not implemented). Reason is recorded; BLOCKED never counts as green.
- **SKIP**: capability absent by design and listed in `knownExceptions` (e.g. tool capture for non-Codex clients). Rendered as a documented exception, but does not satisfy a required run or produce exit 0.

Release gate = all parity-required cells PASS for every supported client, isolation check
PASS, no unexplained duplicate or missing rows, and every exception written down.

## 6. Evidence, scoring, isolation

### 6.1 Evidence bundle (per run)

```
<run>/
  candidate.json          version, git sha, dirty flag, npm pack file list + integrity, mode
  run.json                run id, marker, os/arch, node, client versions, config shape hashes
  home/                   the throwaway home (kept on failure, pruned on success unless --keep)
  logs/midbrain-*.log     hook + plugin + server logs at debug level
  evidence/<client>/<scenario>/
    turn-<n>.ndjson       raw client stream (stream-json / codex JSONL)
    turn-<n>.json         normalized Turn
    readback.json         API rows matched to the sub-marker
    transcript.jsonl      Claude transcript copy (when available)
  results.json            every cell with checks, status, prompt, expected, evidence refs
  report.md               side-by-side matrix + per-cell detail
  isolation.json          tripwire before/after diff
```

### 6.2 Primary vs supplementary evidence

Primary: API read-back rows, raw tool calls/results from the client stream, hook logs, on-disk
receipts (cache/spool counts, codex turn dirs, capture-client marker). Supplementary: the
assistant's final text (used only where the scenario is about the answer itself: S2, S3, S5, S6, S8).

### 6.3 Determinism controls

- Frozen prompts, frozen expected outcomes, and a fixed model per client
  (`MIDBRAIN_HARNESS_CLAUDE_MODEL`, `MIDBRAIN_HARNESS_CODEX_MODEL`) recorded in `run.json`.
- Read-back polling with a hard ceiling (default 90 s) and an indexing grace before recall
  turns (default 20 s) so timing never masquerades as a product failure; both values are recorded.
- Each cell is retried **zero** times by default. `--retries 1` is allowed for triage and is
  flagged in the report; a cell that passes only on retry is reported as FLAKY, not PASS.

### 6.4 Isolation from the host's real configuration

Before any child runs, the harness hashes the real-home surfaces from
`tripwireSurfaces()` **plus** live-client surfaces the existing tripwire does not know about:
`~/.claude/.credentials.json`, `~/.claude/CLAUDE.md`, `~/.codex/auth.json`, `~/.codex/AGENTS.md`,
`~/.npmrc`, `~/.config/opencode/AGENTS.md`, `~/.hermes/SOUL.md`, `~/.config/midbrain/config.json`,
`~/.config/midbrain/.midbrain-keystore.json`. For `~/.claude.json` and `~/.claude/settings.json`
the comparison is **semantic** (only `mcpServers`, `projects.*.mcpServers`, `hooks`,
`permissions`) because a live host Claude session legitimately rewrites other keys in those
files. Any drift fails the run's isolation cell and the report names the surface (never contents).

Guards in `doctor`: refuses if `MIDBRAIN_HARNESS_API_KEY` hash-matches any real-home key file;
refuses if the run root resolves inside `os.tmpdir()`; warns if `CI` is set.

## 7. Candidate freezing and the registry mode

Both modes are implemented in `harness/lib/candidate.mjs` and `harness/lib/registry.mjs` and were
verified offline on 2026-09-07 (installer + adapter inspect + tripwire, no client sessions).

- **dev mode** (`--mode dev`, default): `candidate.json` records `package.json` version,
  `git rev-parse HEAD`, dirty status and `npm pack --dry-run --json` (file list, integrity, size).
  Clients are pointed at the run-owned extracted package by the installer's `--dev` switch.
  MCP and dev shims execute that preserved package, with dependencies installed from the saved
  source lockfile. The source checkout can no longer change the running candidate.
  Limitations: S9 cannot run; OpenCode plugin self-repair is intentionally disabled for dev installs;
  dev-marked shim bodies are never judged stale, so the self-repair smoke strips the exec bit instead.
- **registry mode** (`--mode registry`): a loopback Verdaccio (`npx -y verdaccio@6`, uplink to npmjs)
  starts in `<run>/registry`; the throwaway home gets an `.npmrc` (`registry=` + a dummy token) and
  every child also receives `npm_config_registry`. The candidate is `npm pack`ed and published as
  `latest`. Publish version rule: the exact `package.json` version when npm does not have it yet
  (a real pre-release candidate → **exact tarball**); otherwise `X.Y.(Z+1)-rc.<sha7>` produced by
  extracting the original tarball, rewriting only `package.json#version`, and re-packing (both
  sha256 values are recorded; the working tree is never modified). Installs then run through the
  product's real path, `npx -y midbrain-memory-mcp@latest install …`, and the MCP entries/shims are
  the canonical non-dev ones.
- **upgrade prelude** (`--mode registry --upgrade`, feeds S9): publish is deferred; the installer
  resolves the **previous published release** through the proxy; each client captures a
  pre-upgrade marker; the candidate is published; the harness applies the documented user path for
  a stuck npx cache (`rm -rf ~/.npm/_npx`, which is also what the product's own self-heal does);
  the next resolution runs the candidate; each client captures a post-upgrade marker, the adapters
  must still report the install fresh (no duplicate hooks), and a fresh session must recall the
  pre-upgrade marker. The rest of the matrix then runs on the upgraded install, which is the state
  existing users will be in.

**Finding — Claude MCP config path vs CLAUDE_CONFIG_DIR (first two-client run, 2026-09-07).** The
product's Claude adapter writes the MCP server to `$HOME/.claude.json` (via `os.homedir()`, which
ignores `CLAUDE_CONFIG_DIR`). Claude Code, when `CLAUDE_CONFIG_DIR` is set, reads MCP config from
`$CLAUDE_CONFIG_DIR/.claude.json` instead — a different file — so the installed server is never
loaded and headless recall has no memory tools (capture still works: hooks live in settings.json,
which lined up). The harness therefore isolates Claude with `HOME` alone and does NOT set
`CLAUDE_CONFIG_DIR`, keeping the installer and the CLI on the same `$HOME/.claude.json`. Verified:
with the override removed, `claude mcp list` shows `midbrain-memory ✔ Connected`. (This contradicts
the generic advice to always set `CLAUDE_CONFIG_DIR`; it only holds for tools that themselves honor
it, which this product does not.)

**Claude Code headless assistant capture.** The first live run exposed lost assistant
capture when `claude -p` exited before its asynchronous Stop hook completed. The
product now installs a synchronous Stop hook with the existing 30-second timeout.
The harness only observes native captures; it never replays hooks to fill a gap.
A missing native capture fails the scenario.

**Product change request (found while building this):** `install.mjs` fetches
`https://registry.npmjs.org/midbrain-memory-mcp/latest` from a hard-coded constant and
`isNewerVersion` only accepts stable `X.Y.Z` strings. The built-in 24 h self-heal therefore cannot
be exercised against a loopback registry or an rc candidate. Honouring an override (for example
`MIDBRAIN_NPM_REGISTRY_URL`, or npm's configured registry) would let the harness prove the
self-heal path end to end instead of emulating it with the cache clear.

Both lanes consume the same `candidate.json`; every result row embeds its version and SHA.

## 8. Pipeline and runners

```
freeze candidate ─► npm run check on ubuntu/windows/macos (existing ci.yml)
                 ─► harness doctor  (self-hosted macOS + linux runners)
                 ─► harness run --clients claude,codex,opencode,hermes[,nanoclaw] --scenarios all
                 ─► report.md + evidence bundle uploaded as workflow artifacts
                 ─► Radu review ─► publish ─► harness run --mode registry --scenarios s9 (post-release smoke)
```

- `.github/workflows/behavioral.yml` (phase 2): `workflow_dispatch` + release branches; runs on
  a self-hosted macOS runner (Claude, Codex, OpenCode, Hermes) and a self-hosted Linux runner
  with Docker (NanoClaw). Secrets: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MIDBRAIN_HARNESS_API_KEY`,
  `MIDBRAIN_HARNESS_PROJECT_API_KEY`. GitHub-hosted runners keep the programmatic lane only.
- Local mock-up (now): this Mac, `harness/.env` with the same four secrets, `node harness/run.mjs doctor`
  then `node harness/run.mjs run --clients claude,codex`.

## 9. Phasing

| Phase | Scope | Exit criterion |
|---|---|---|
| 0 (this PR) | `harness/` skeleton, design doc, Claude + Codex + OpenCode + Hermes manifests (OpenCode and Hermes installed run-locally), S1 S2 S3 S5 S6 S7 S8 + install/self-repair checks, report, tripwire, registry mode + upgrade prelude (S9) | `doctor` green on this Mac; `run --clients claude,codex,opencode,hermes` produces a report with real evidence |
| 1 | First live runs and driver fixes; S4 with a second agent key; OpenCode plugin/process-separation cell; frozen prompts replaced by the maintainer's documented scenarios | four-client matrix green locally |
| 2 | `behavioral.yml` on a self-hosted macOS runner; report attached to release PRs; product registry-URL override so the built-in self-heal is exercised | release gate enforced for a real release |
| 3 | NanoClaw driver implemented (pinned v2 runner, native capture, cold wake, resume, legacy fixture); Docker Linux CI and Windows behavioral leg remain | five-client parity table complete |

## 10. Open decisions for review

1. **Model pinning per client.** Behavioral cells are more stable on a fixed model; the report
   records it. Proposal: pin Claude and Codex models via env, default to each client's default.
2. **Permissions in headless mode.** The installer pre-allows the six read-only memory tools for
   Claude, so no bypass flags are needed. For Codex the harness defaults to
   `--dangerously-bypass-hook-trust` and tests persisted trust as a separate S10 cell. Confirm.
3. **Shared vs isolated homes.** Default shared (realistic, exercises cross-client convergence);
   isolated available for triage. Confirm.
4. **Prompt ownership.** Draft prompts above are placeholders for the maintainer's frozen set;
   once supplied they are checked into `harness/scenarios/` and never edited without a version bump.
5. **Test identity.** One dedicated MidBrain agent per environment (local, runner). Memory
   written by the harness accumulates; propose a periodic wipe or per-month agent rotation.


## NanoClaw implementation boundary

The NanoClaw manifest now owns a Docker runtime and its S10 lifecycle cases, instead of
returning an unconditional BLOCKED. See [harness setup and commands](../../harness/README.md#nanoclaw).
The source pin and upstream runner lockfile are checked before launch. Dev mode packs the
frozen candidate into a temporary container install; canonical and upgrade runs resolve the
candidate through the run-local registry. Upgrade checks also query the version inside NanoClaw's
container, rather than accepting only the host's `npx --version` as evidence.

The harness writes only the transport's inbound mailbox. The unmodified NanoClaw runner
writes replies, processing acknowledgments, and its real SDK continuation. Native Claude
transcripts supply tool calls and results; native Stop hooks finish against the
real API. Container restart tests reuse only durable group/session mounts. A readiness-only
MCP probe lists all twelve tools and is distinct from behavioral recall evidence.

The legacy opener fixture removes the durable hook and capture marker and restores the
historical hook path/config. It checks the candidate's actual startup recovery, without
synthesizing captures. This fixture is distinct from the previous-package-to-candidate S9
upgrade lane. Dev mode reports the migration cell BLOCKED. Any BLOCKED required cell makes
the command unsuccessful, even if other cells pass.

Cross-client recall now seeds a random verification value visible only in the writer's turn.
Both the reader's successful MCP result and final answer must contain that value. Echoing or
retrieving the reader's own marker-bearing question cannot pass the cell.

The adapter uses local transport instead of external messaging integrations. It does not
validate Slack/WhatsApp, the full NanoClaw host dispatcher, OneCLI provisioning, or all model
providers. Its behavioral CI/release scheduling and Linux validation remain to be wired and
verified; the implementation alone is not evidence of five-client release parity.

## Release review for the hardening changes

Two product changes require Radu's release review; passing harness checks do not grant that approval:

- `f84c5f6`: synchronous Claude Stop hooks and migration from owned asynchronous hooks.
  Capture now completes before one-shot exit, within the existing 30-second timeout.
- `5b1f1fe`: one-layer decoding of recognized NanoClaw user transport envelopes, including
  legacy opener recovery. Stored human text changes; native transcript evidence is retained.

The harness is a separate commit. NanoClaw formatting retries are a documented exception
only to one-reply-per-input expectations; every observed native reply still needs exactly
one capture. A required matrix report records failures and blocked cases without waivers.
