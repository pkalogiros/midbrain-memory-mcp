# Multi-Client MCP Testing Harness — Design

Status: implemented harness, evidence export, and remaining release work (2026-09-09). Owner: Pantelis (operations). Reviewer: Radu (technical).
Baseline: `origin/main` = v0.4.10 (`b09f9f6`), 49 Vitest files / 1,237 cases, CI matrix ubuntu + windows + macos.

This document turns the "multi-client MCP testing overview" into a concrete pipeline
that lives in this repository under `harness/`. It is written against the code as it
exists today; every path, env var, and hook name below was verified in source.

For a shorter introduction, see [how the harness works](harness-how-it-works.md).
Runner settings and deployment steps live in [workflow setup](behavioral-ci.md).

---

## 1. Goal and definition of done

A release candidate has **feature parity** when it passes two lanes on the **same frozen
candidate**:

| Lane | Proves | Mechanism | Exists today? |
|---|---|---|---|
| Programmatic | package, installer, hooks, config, credentials, self-repair, capture and recovery paths behave deterministically | Vitest suite + gate scripts + OS matrix | Yes (see §3) |
| Behavioral | real agents in real clients capture, recall, continue, reconcile, stay clean on no-match, and read memory written by other clients | `harness/` launches real client sessions and scores raw evidence | Implemented for all five clients; complete passing required matrix still needed |

Parity is asserted at three levels: package parity (OS matrix), client-integration parity
(tools exposed, scope resolved, events captured, metadata correct, self-repair safe), and
behavioral parity (agents actually use MidBrain correctly). Clients may use different
mechanisms; only the observable outcomes must match.

## 2. What already exists and is reused, not rebuilt

| Existing piece | Location | Reused for |
|---|---|---|
| Client adapters (`id`, `isInstalled`, `installGlobal`, `installProject`, `isFresh`, `repair*`) | `shared/clients/{base,registry,claude,codex,hermes,nanoclaw,opencode}.mjs` | The harness manifests wrap these; install goes through the real installer, never a parallel implementation |
| Throwaway-home fixture + managed env key list | `tests/helpers/test-env.mjs` (`makeTestEnv`, `MANAGED_ENV_KEYS`, `sandboxPaths`) | Env scrubbing list and detection-fixture recipe |
| Real-home tripwire (hash-before / hash-after on enumerated real config surfaces) | `tests/helpers/global-tripwire.mjs` (`tripwireSurfaces`, `collectHashes`, `diffHashes`) | Imported directly; extended with live-client surfaces (§6.5) |
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
| Upgrade from previous published version | `install.test.mjs` (update check, npx cache clear), `api-host-migration`, `hook-ownership`, NanoClaw cold-upgrade e2e | Implemented in registry/upgrade mode (§7); automatic 24 h update discovery and real-npm post-publish smoke remain separate |
| Manual + startup self-repair | `self-repair-safety`, `hostile-home`, `shim-freshness`, `nanoclaw-topology.e2e`, `cache-boot-drain` | — |
| Credential precedence, API host binding | `client-base`, `credential-*`, `keystore`, `api-host*`, `mcp-api-host` | — |
| Per-client config formats | `client-{claude,codex,hermes,opencode,nanoclaw}` | — |
| Tool registration / schemas | `mcp.test.mjs` only | thin, but exact (12 tools, exact names, schemas) |
| User / assistant / tool capture | `claude-shim-e2e`, `codex-hooks`, `hermes-hooks`, `client-opencode-runtime`, `nanoclaw-topology.e2e` | Programmatic tests are shim/plugin driven; S1/S8/S10 add real-client evidence |
| cwd / session metadata | `capture-metadata`, runtime tests | — |
| Duplicate / missing capture | `claude-opener-recovery`, `claude-spool`, `cache-boot-drain`, e2e | — |
| Offline cache / spool recovery, races | `episodic-cache`, `claude-spool`, `flush-runner`, e2e | — |
| Package contents / exact version | `docs-regression` (`npm pack --dry-run`), `check-pinned-spec.sh` | — |
| Host isolation | `global-tripwire`, `env-isolation`, `credential-isolation`, `check-test-isolation.sh` | Live runs recorded clean isolation; the tripwire detects changes on enumerated surfaces (§6.5) |
| Uninstall idempotency | — | **no uninstall exists in the product** |
| Windows shim chain e2e | — | all spawn-based e2e are `skipIf(IS_WIN)` |

Existing CI runs build/tests on macOS, Windows and Linux; `npm run check` also runs once
on Linux. The harness adds package identity and per-client install/freshness checks. Tool
availability comes from native initialization, successful calls or a client probe; exact
tool schemas remain programmatic coverage. These lanes are not yet joined by a release workflow.

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
    report.mjs            render report.md from results.json
  scripts/
    release-evidence.mjs  offline export and verification of completed runs
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

Adding a client means adding a manifest file and registering it in
`harness/clients/index.mjs`; shared scenarios and scoring stay unchanged. A manifest declares:

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
| NanoClaw | Implemented: pinned upstream runner in Docker, isolated SQLite mailbox and durable per-group state/npm cache | Stop payload `session_id` | transcript under `/home/node/.claude/projects`, spool/receipt files |

Hermes's run-owned config sets `mcp_discovery_timeout: 30` so cold npx startup
can finish before its first tool snapshot (Hermes 0.19 defaults to 1.5 seconds).
The export reader accepts nested session envelopes and flat JSONL messages;
only the current turn's successful tool calls count as recall evidence.

OpenCode uses its current-turn JSON stream for answers and tool calls; session
exports remain supporting artifacts. When native MCP metadata identifies a truncated
response, the adapter retains the complete file from the run's OpenCode tool-output
directory for scoring. A truncated export cannot erase current-turn evidence or
credit calls from an earlier resumed turn.

Claude's cold-first-turn case creates a separate fresh home and npm cache when an
upgrade prelude has already warmed the main home. S1 in that warmed home is not
credited as cold-start evidence. Codex's persisted-approval case opens the native
UI with `--interactive` or automates that UI with `--approve-codex-hooks`, then checks
capture in a fresh process without the bypass. Automation requires Codex 0.150.1 and Python 3;
it validates the discovered definitions and their persisted hashes through `hooks/list`.

All children receive a **scrubbed env**: `HOME`/`USERPROFILE` → run home; `TMPDIR`/`TEMP`/`TMP`
→ `<run>/tmp`; `CODEX_HOME`, `HERMES_HOME`, `npm_config_cache` inside the
run home; `CLAUDE_CONFIG_DIR` is unset so Claude reads the installer's `$HOME/.claude.json`;
`MIDBRAIN_LOG_DIR=<run>/logs`, `MIDBRAIN_LOG_LEVEL=debug`; **deleted**: `CI`,
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

## 5. Behavioral coverage and prompt ownership

The user's overview asks for the workflows below. Each row maps that checklist to the
current executable scenario. Exact prompts are defined in `harness/scenarios/` and saved
as `<label>.prompt.json` for every turn; the run also preserves and hashes those source files.
The descriptions here summarize the implementation, not a second set of prompt templates.

| Overview requirement | Implementation / source under `harness/` | What the current check establishes |
|---|---|---|
| Capture, metadata, duplicates | `scenarios/s01-capture.mjs` | Marker-bearing user/assistant rows, session/client/cwd metadata, settled counts and no foreign-client rows. NanoClaw expects exactly one capture per native reply. Literal marker obedience is part of this check; a paraphrase can fail even if capture occurred. |
| Cross-client recall | `scenarios/s02-cross-client-recall.mjs` | Default/required: all 20 directed pairs for five clients. `--simple`: five links in manifest order forming a directed cycle. Both require hidden writer values in successful MCP evidence and the reader's answer. |
| Fresh-session continuity | `scenarios/s03-fresh-session-continuity.mjs` | New session retrieves hidden function names from the previous checkpoint and reports them correctly. |
| Project/global memory | `scenarios/s04-project-global-isolation.mjs` | Separate agent keys; direct store checks in both directions, project lookup and global fallback from another directory. The model asks global-for-project, project-for-project and global-for-global; there is no separate project-for-global reader turn. |
| Current-state reconciliation | `scenarios/s05-freshness-reconciliation.mjs` | Newer state-changing memory wins over an older memory; hidden current value appears in successful recall and an unambiguous JSON answer. Conflicting live repository/file state is not exercised. |
| Clean no-match behavior | `scenarios/s06-no-match-clean.mjs` | An unrelated factual question gets a clean answer without MidBrain process language. This does not force a failed memory lookup; S4 separately exercises a scoped not-found response. |
| Memory-first rules (S7) | `lib/checks.mjs`, called by S2/S3/S5 | First tool is memory/discovery, full anchor preserved, and an observed empty result triggers a wider/different search. No separate S7 driver. |
| Literal marker robustness | `scenarios/s08-marker-robustness.mjs` | Marker-like user text remains intact, answer echoes it, and an assistant row containing the marker is captured. |
| Upgrade continuity | `lib/upgrade.mjs`, `scenarios/s09-upgrade-continuity.mjs` | Previous published package → locally served candidate; cache resolution reset, install freshness, new capture and recall of pre-upgrade values. Does not prove automatic update discovery or post-publish upgrade against real npm. |
| Client-specific behavior | `scenarios/s10-client-specific.mjs`, `scenarios/nanoclaw-lifecycle.mjs` | Claude fresh-home first turn and shim repair; Codex capture before/after native approval and project trust; Hermes consent; OpenCode plugin-only capture; NanoClaw cold wake, resume and legacy recovery. |

This reconciles the implementation with the overview supplied in the conversation. The
maintainer's separate manual prompts/edge-case list has not been supplied here, so exact
manual-suite equivalence remains unconfirmed. Review these rows against that list when it
arrives; do not describe the current prompts as maintainer-approved or silently add scenarios.
PK can be enabled through `MIDBRAIN_HARNESS_PK`, but there is no separate scored PK lane.

### Implemented versus validated

- **Implemented:** five adapters, the checks above, package freezing, native capture,
  isolated workspaces, registry upgrades, deterministic scoring, and offline evidence export.
- **Recorded validation:** see [2026-09-08 validation](validation-2026-09-08.md). The original
  required run finished 93 PASS / 27 FAIL / 1 BLOCKED. The later four-client run was
  32 PASS / 1 FAIL; a separate OpenCode rerun passed after its fix. A subsequent required
  run stopped on provider billing. The completed broad run `20260909-083452-4fdd` tested
  `6d6fc58` and finished 108 PASS / 16 FAIL / 1 BLOCKED, with clean isolation and
  `required: false`. It predates the native Codex approval driver. Reports are retained
  without rewriting outcomes; this checkpoint does not validate the current candidate.
- **Pending proof:** a complete passing required matrix for the chosen candidate and model
  pins, plus Radu's release review. Passing local programmatic checks and the focused native
  approval check do not establish that full behavioral result.
- **Outside current proof:** Linux NanoClaw behavioral validation, broader supported OS/client
  combinations, CI/release enforcement, automatic update discovery, real-npm post-publish
  smoke, and the scope limits in the table above. No uninstall exists to test.

### 5.1 Cell status rules

- **PASS**: every check in the cell true.
- **FAIL**: any check false.
- **BLOCKED**: prerequisite missing (client binary absent, secret absent, Docker down, registry mode not enabled, driver not implemented). Reason is recorded; BLOCKED never counts as green.
- **SKIP**: capability absent by design and listed in `knownExceptions` (e.g. tool capture for non-Codex clients). Rendered as a documented exception, but does not satisfy a required run or produce exit 0.

Release gate = all parity-required cells PASS for every supported client, isolation check
PASS, no unexplained duplicate or missing rows, and every exception written down.

## 6. Evidence, scoring, isolation

### 6.1 Private run evidence

```
<run>/
  candidate.json          version, git sha, dirty flag, npm pack file list + integrity, mode
  home/                   durable private home; contains credentials, never upload
  logs/midbrain-*.log     hook + plugin + server logs at debug level
  evidence/<client>/<scenario>/
    turn-<n>.ndjson       raw client stream (stream-json / codex JSONL)
    turn-<n>.json         normalized Turn
    readback.json         API rows matched to the sub-marker
    transcript.jsonl      Claude transcript copy (when available)
  results.json            run/models/clients/candidate identity and every cell with checks/evidence
  report.md               side-by-side matrix + per-cell detail
  isolation.json          tripwire before/after diff
```

### 6.2 Shareable release evidence

`node harness/scripts/release-evidence.mjs export <completed-run> <new-bundle-directory>`
produces a selected, redacted review bundle outside the run. It contains `report.md`,
`results.json`, `candidate.json`, a README, normalized turns/prompts/readbacks, the native
approval receipt when present, and a checksum manifest. Raw streams, complete transcripts,
installer logs, configs, databases, package archives and run homes are not copied.
Omitted references are recorded, and report references point only to exported evidence.

The exporter reads known credentials from the run's own files and current harness env for
redaction, also masks structured secret fields/token patterns, and removes host/run paths.
Review the bundle before sharing: arbitrary sensitive text cannot be exhaustively detected.
Native raw evidence remains available privately if a reviewer needs to audit normalization.

`node harness/scripts/release-evidence.mjs verify <bundle> <release.tgz> <full-source-sha>`
checks checksums, report/results agreement, coverage, model/client versions, clean isolation,
passing underlying checks and the existing `runExitCode` rule. It also matches the intended
release's exact archive hash and source SHA. Focused, failed, blocked and dirty-source runs
can be exported as **checkpoints**, but do not pass release verification. Partial or
interrupted runs without completed results cannot be exported. Export success itself is
not a passing gate. Checksums provide integrity, not a signature or proof of authorship.

Registry mode may rewrite a package to an RC version. Its tested archive hash then differs
from the original source archive: a stable-version repack needs its own validation. Bundle
verification does not approve a different archive because the git SHA happens to match.
See the [release checklist](../releases/README.md#release-validation-checklist).

### 6.3 Primary vs supplementary evidence

Primary: API read-back rows, raw tool calls/results from the client stream, hook logs, on-disk
receipts (cache/spool counts, codex turn dirs, capture-client marker). Supplementary: the
assistant's final text (used only where the scenario is about the answer itself: S2, S3, S5, S6, S8).

### 6.4 Determinism controls

- Frozen prompts, frozen expected outcomes, and a fixed model per client
  (`MIDBRAIN_HARNESS_CLAUDE_MODEL`, `MIDBRAIN_HARNESS_CODEX_MODEL`) recorded in `results.json`.
- Read-back polling has a hard ceiling (default 90 s), plus indexing grace before recall
  turns (default 20 s). Both are recorded; timeouts still require infrastructure/product triage.
- Scenarios have no automatic retry option. Targeted reruns produce separate reports;
  a passing follow-up never changes an earlier failed result.

### 6.5 Isolation from the host's real configuration

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
  `git rev-parse HEAD`, dirty status and an actual `npm pack --json` archive (file list, integrity, size).
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

Behavioral results contain the frozen candidate identity at run level. Existing programmatic
CI builds from checkout; joining both lanes to the same release artifact remains workflow work.

## 8. Running and deploying the harness

Today this is a repository tool, excluded from the public npm package. Run it locally with
Node 24 and the prerequisites in [harness/README.md](../../harness/README.md). The local
stack helper starts the API; the behavioral runner itself does not provision cloud services.

A complete release check currently follows this sequence:

```text
programmatic CI + exact candidate archive
  → healthy dedicated API + pinned clients/models
  → run --mode registry --upgrade --required --approve-codex-hooks
  → export and verify release evidence against the intended archive and source SHA
  → Radu review → separately authorized publish
```

The required run automates Codex's native hook browser with `--approve-codex-hooks`
on Linux/macOS. Manual `--interactive` approval remains available. Both paths keep the
no-capture-before/capture-after checks; a trust bypass does not satisfy persisted approval.

A manually triggered [behavioral workflow](../../.github/workflows/behavioral.yml) is now built
with pinned clients/models, serialized execution, bounded runtime, health checks, selected
evidence artifacts and scoped cleanup. It is not deployed or cloud-validated. See
[setup and execution boundaries](behavioral-ci.md). Linux execution needs validation first.
Native approval automation preserves the before/after capture proof; its presence does
not establish a passing required matrix. Runner provisioning and a real-npm post-publish
smoke mode are not implemented.

## 9. Remaining decisions and release boundaries

1. Confirm the overview-to-scenario mapping in §5 against the maintainer's separate manual
   checklist. The supplied overview is mapped; the absent checklist is not assumed covered.
2. Pin model and client versions before a run. Different pins establish a different tested
   configuration; cheaper-model failures remain recorded and need triage.
3. Run the full required gate and obtain Radu's review of all four product changes below.
   Evidence export is ready; it cannot manufacture a passing run.
4. Validate Linux execution, including the implemented native approval driver. The workflow
   currently targets a self-hosted runner; a GitHub-hosted Ubuntu trial is proposed in the
   [deployment sequence](behavioral-ci.md#deployment-sequence-proposed). It has not been
   implemented or dispatched. Broader OS coverage and post-publish upgrade smoke remain separate work.


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
providers. The manual behavioral workflow is built; runner activation and Linux validation
remain pending. The implementation alone is not evidence of five-client release parity.

Each NanoClaw group has its own agent workspace. It uses the selected project's
memory credential without replacing the host project's instructions or sharing
client-local memory files with Claude, Codex, OpenCode, or Hermes.

## Release review for the hardening changes

Four product changes require Radu's release review; passing harness checks do not grant that approval:

- `f84c5f6`: synchronous Claude Stop hooks and migration from owned asynchronous hooks.
  Capture now completes before one-shot exit, within the existing 30-second timeout.
- `5b1f1fe`: one-layer decoding of recognized NanoClaw user transport envelopes, including
  legacy opener recovery. Stored human text changes; native transcript evidence is retained.

- `477bd79`: managed rules prioritize MidBrain recall before local files and preserve full
  retrieval IDs. Startup migrates recognized generated blocks on detected client surfaces;
  custom rules are preserved. This changes agent instructions, not just harness prompts.
- `03b6271`: OpenCode tracks pending capture work and drains it during native plugin `dispose`,
  bounded to 30 seconds. Normal chat stays asynchronous; shutdown can wait. Verified with
  OpenCode 1.18.29; older clients without `dispose` are not established by that proof.

Harness changes remain separate from these product release decisions. NanoClaw formatting retries are a documented exception
only to one-reply-per-input expectations; every observed native reply still needs exactly
one capture. A required matrix report records failures and blocked cases without waivers.
