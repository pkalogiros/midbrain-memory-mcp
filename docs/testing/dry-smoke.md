# Dry-smoke: MCP integration without model calls

`dry-smoke` is a mode of the existing multi-client harness. It freezes the current
checkout into an npm package, runs the real installer in an isolated home, launches
the installed MCP integration, exercises all 12 tools against a local fixture API,
and asks the installed clients to connect or discover tools. It writes the existing
JSON, Markdown and offline HTML reports.

No model prompt is sent. No MidBrain deployment, Docker, model key, or MidBrain key
is required. The API is a small deterministic HTTP fixture with synthetic responses;
it does not run embeddings, retrieval, or the memory engine. Package preparation
and optional client installation can download dependencies, so this is not an
entirely offline run or a network sandbox.

## Run it

From the repository root, with Node 20+, npm and Git available:

```bash
npm ci
node harness/run.mjs dry-smoke
```

The default clients are **OpenCode, Claude Code, Codex, Hermes and Pi**. Unlike the
behavioral default, this includes Pi and excludes NanoClaw's Docker lane.

```bash
# Narrow the matrix to locally available clients.
node harness/run.mjs dry-smoke --clients claude,codex

# Install missing OpenCode, Hermes and Pi into this run's tools directory.
# Hermes installation also requires uv on PATH.
node harness/run.mjs dry-smoke --install-clients

# Choose where to keep the evidence.
node harness/run.mjs dry-smoke --root /tmp/midbrain-dry-smoke
```

Claude and Codex must already be on PATH. The harness launches all probes itself;
you do not open client sessions manually. Existing client executables are reused,
but their normal homes, login files and provider credentials are not copied.
The command does not load the harness `.env`. Model/API/scenario/upgrade flags are
rejected instead of being silently ignored. There is no automatic fallback to a
model-backed test.

For reproducible client installations, set `MIDBRAIN_HARNESS_OPENCODE_VERSION`,
`MIDBRAIN_HARNESS_HERMES_VERSION` and `MIDBRAIN_HARNESS_PI_VERSION` before using
`--install-clients`. Every successful native probe records the actual client version.
The candidate is always the current checkout, packed and installed with frozen dev
paths; registry auto-update and upgrade behavior belong to the behavioral suite.

## What is tested

| Area | Evidence |
|---|---|
| Package and install | Built npm archive, frozen package/harness hashes, real installer, repeat installation and product adapter inspection |
| Existing configuration | A harmless sibling MCP entry (or Pi extension) survives install, reinstall and tool-driven project setup |
| MCP transport | The installed command points to the frozen candidate, records the negotiated MCP version, server identity and tools capability; verifies ping, unknown-method rejection, unknown-tool rejection and unchanged discovery on the same connection; checks stdout for protocol corruption |
| Tool contracts | All 12 tools invoked; concurrent requests retain their own responses; response text/structure and recorded HTTP paths, query parameters, body and credential scope checked |
| Account tools | Synthetic user-key storage, agent listing/creation/key minting, catalog storage and project selection |
| Failure recovery | Invalid argument types/ranges, HTTP 401/503, malformed JSON, backend connection loss, missing/empty keys, corrupt account store and legacy GET-to-POST fallback; valid calls succeed afterward |
| Restart | A fresh MCP process discovers the same tools and reads persisted project credentials and account state |
| Project isolation | Project key beats global key; global key stays unchanged; replacing a project key requires explicit `replace: true` |
| Privacy and host isolation | Tool results do not disclose synthetic secrets; evidence redacts fixture keys; existing real-home tripwire must remain clean |
| Native compatibility | Separate connection/discovery probes, with exact evidence levels below |

The per-tool table separates discovery, schema, positive execution, invalid input
and failure recovery. Each of the 12 schemas is checked against an independent
baseline for argument names, types, required fields, bounds and defaults. Each of
the nine tools accepting arguments receives a deliberately invalid type. The three
argument-free tools show N/A for that check. This does not claim every possible
invalid input has been tested. Recovery is exercised for search, grep, date retrieval, file listing/reading, session status, account listing and selection. Agent creation also tests key-mint failure, successful rollback, failed rollback, unchanged credentials and a later successful call. Remaining gaps are explicitly NOT COVERED.

The direct probe speaks real MCP over stdio. Pi uses the installed bridge with a
small harness host to execute tools; the separate native Pi check loads the extension
in the installed Pi runtime. Pi stdout validation additionally opens the configured
MCP command with an SDK client, because the bridge owns its own parser. For Hermes, the direct probe substitutes the workspace
for the installed `${TERMINAL_CWD}` placeholder. That substitution is harness-provided
context, not proof of Hermes's project-context propagation during a model session.

| Native client | Model-free probe | What a pass proves |
|---|---|---|
| Claude Code | `claude mcp list` | The real CLI reports MidBrain connected |
| OpenCode | `opencode mcp list` | The real CLI reports MidBrain connected |
| Codex | `codex app-server --stdio`: initialization and `mcpServerStatus/list` | The real app-server discovers all 12 tools; no thread or model turn is created |
| Hermes | `hermes mcp test midbrain-memory` | The real CLI connects and lists all 12 tools |
| Pi | Installed SDK session, extension startup and shutdown | The installed runtime loads the installed extension and exposes all 12 tools; no `prompt()` call |

Direct execution and native discovery have separate report rows. A native client
listing a configured entry is insufficient. The harness also rejects another MCP
server's successful connection as evidence about MidBrain. A sibling integration
is one concrete coexistence case, not an exhaustive test of third-party conflicts.

## Missing prerequisites and failures

**PASS** means the recorded check succeeded. **FAIL** means a tested contract broke,
a process failed or timed out, or real-home isolation changed. **BLOCKED** means a
required client/dependency is absent, the driver does not support this OS, or the
client version cannot provide recognizable model-free discovery evidence.

All three of **FAIL, BLOCKED and incomplete coverage exit nonzero**. Dry-smoke is
stricter than the behavioral command's default treatment of BLOCKED. Inspect the
per-check detail and native/MCP evidence before diagnosing the product: a missing
binary and a broken MCP response are different failures.

The runner continues through independent client cases when possible, saves results
after each client, bounds process execution, and closes child processes and the
fixture listener on normal completion or interruption. Ctrl+C leaves incomplete
evidence and a failing exit code; it cannot turn an interrupted run into a pass.
A shared setup failure, such as being unable to bind localhost, prevents the run.
A hard kill or host crash can leave only the last saved partial report.

The regression suite deliberately tests broken MCP startup, stdout corruption
with otherwise successful tool answers, missing/duplicate evidence, wrong HTTP
parameters and incomplete native inventories. These cases must fail instead of
manufacturing a passing result from a successful process exit.

## Reports and automation

Open the printed `report.html` path. It shows individual assertion counts,
a coverage matrix, the precise native evidence level for each client, actionable
failure details, run provenance, and searchable/filterable assertion details.
The page works offline with no external fonts, scripts or analytics. Evidence
links work when the report and evidence directory stay together. Print includes
the expanded assertions.

Stable check IDs define the expected probe coverage. Missing, duplicated, unknown
or malformed check records fail evidence validation. The gate also checks that
every selected client has every required coverage row; an incomplete matrix
cannot pass simply because the recorded cells are green. Model prompts are zero
by construction of the allowlisted operations; this is not a packet-level
network audit.

Alongside the HTML report are:

- `results.json`: checks, strict statuses, scope, actual host OS/architecture, versions
  and zero-prompt run identity.
- `report.md`: the same matrix and detailed checks in Markdown.
- `junit.xml`: individual assertions for CI test viewers, plus an explicit failing
  gate case when coverage is blocked, incomplete or host isolation fails.
- `candidate.json` and `candidate/`: the preserved package and hashes.
- `evidence/<client>/dry-smoke/mcp-probe.json`: tool calls and fixture requests.
- `evidence/<client>/dry-smoke/native-probe.json`: native version, output and verdict.
- `evidence/fixture-requests.json` and `isolation.json`: backend traffic and host drift.

Use `node harness/run.mjs report <runDir>` to regenerate dry-smoke reports. Retained run
homes contain only synthetic test credentials, but include paths and logs; share
selected reports and evidence rather than the entire run directory.

The **MCP integration (no models)** workflow runs this harness on Linux and macOS for relevant pushes and pull requests, and supports manual dispatch. The **Behavioral tests** workflow reuses it for its `dry-smoke` choice. Neither requires the behavioral environment or provider secrets. The normal CI test matrix also runs the model-free regression tests on
Linux, macOS and Windows. Workflow configuration is not evidence that a platform
has already passed: inspect the resulting runs.

A local run tests the host it runs on. Docker on a Mac normally tests Linux inside
the container, not native macOS. Full native Windows parity is not claimed: the
Hermes/Pi drivers currently support Linux/macOS, and native CLI installation and
launch behavior still need Windows validation. Use separate native runners for
OS coverage; never relabel a Mac result as a Linux or Windows result.

## Inspect the MCP context preview

Every client gets an **MCP context preview** in the HTML report, plus three logs
under `evidence/<client>/dry-smoke/`:

- `mcp-context-preview.json`: observed tool descriptions/schemas and all call attempts.
- `mcp-context-preview.md`: the same data as a readable transcript.
- `mcp-events.ndjson`: incremental discovery, call-start and call-finish events.

The HTML inspector provides separate **Harness → MCP** arguments and
**MCP → harness** response panels, filters by client and response type, searches
argument/result text, and links directly to individual exchanges. Scenario verdicts
are shown separately from response status: a deliberately rejected call can belong
to a passing validation scenario. Full raw exchanges and tool schemas remain
expandable. The Markdown preview opens with the exchanges; schemas are an appendix.

The preview shows what the harness exposed through MCP: tool names, descriptions,
input schemas, exact arguments and returned content or errors. Pi records its
exposed `midbrain_` names alongside normalized tool names. Calls have stable IDs,
case IDs, connection numbers, timestamps and duration, and remain in invocation
order even when concurrent responses arrive in a different order. Rejected calls
are retained. Synthetic credentials are redacted in the preview and event log.

**This is not the complete request a native client would send to a model.**
Dry-smoke creates and sends no model request. Native system instructions,
conversation assembly, tokenization and provider-specific formatting are not
captured or invented. `returned` means a response arrived; the content and test
assertions determine whether the tool succeeded.

Events are written before a call and when it finishes, so interrupted probes can
retain pending attempts without a fabricated result. A recovered preview is marked
incomplete. Malformed log lines do not discard valid records. Duplicate IDs,
orphaned results, changed arguments or disagreement with the final probe receipt
fail trace validation and prevent a complete recording claim. A hard kill of the entire runner may leave only the incremental event
file; the last saved report may not yet link it.

## What still needs models or the real service

Dry-smoke does not establish memory quality, indexing, ranking, retrieval accuracy,
model choice of tools, model answers, native capture events, fresh-session recall,
upgrade/self-repair, production authentication or service reliability. The separate
[live-smoke mode](live-smoke.md) adds two bounded real-model sessions per client to
verify explicitly requested tool execution and result delivery against the same
kind of synthetic backend. It does not test memory quality. Dry-smoke tests the
MCP's wiring and contracts around a synthetic service. The existing code tests cover
more isolated edge cases; the existing behavioral suites remain the next layer for
real capture and recall. A green dry-smoke report is not a full release sign-off.

## Recorded local validation

Run `20260923-061035-0d5d` passed all 55 client/coverage combinations (380 individual assertions)
on macOS arm64 with zero model prompts and no real-home drift. Native versions:
OpenCode 1.18.32, Claude Code 2.1.280, Codex 0.150.1, Hermes 0.19.0 and Pi 0.87.1.
The local run reused installed client binaries. [Remote native CI also passed](https://github.com/pkalogiros/midbrain-memory-mcp/actions/runs/35867643216) for commit `15f93a4`: dry-smoke recorded 380/380 assertions on Linux x64 (`20260923-133147-6a22`) and macOS arm64 (`20260923-133158-dee2`). Native Windows execution remains unvalidated.

This validation also recorded 66 MCP call attempts per client (330 total), with
tool definitions from initial discovery and restart. All context previews were
complete, with no native model request created or sent.

For native dispatch without LLM inference, run [scripted-smoke](scripted-smoke.md).
Its Pi, OpenCode, Hermes, Claude Code and Codex adapters route all 12 tool calls through the real CLI and capture actual
requests sent back to the local scripted provider. This is separate evidence from
dry-smoke's context preview and from real-model live-smoke.

## Portable review export

Combine this run with other recorded synthetic smoke runs using
`node harness/run.mjs review-bundle <run> [other-run...] --output <new-directory>`.
The export includes an offline overview and selected redacted evidence. Verify it
with `node harness/run.mjs verify-review <bundle-directory>`. A valid bundle can
contain failed or incomplete tests; integrity is separate from test success.
See [review export and verification](mcp-review-bundles.md).

## Protocol evidence and compatibility limits

A separate harness SDK connection records initialization metadata and eight protocol
exchanges: ping, tools/list, an unsupported method, an unknown tool, a controlled
search failure, an empty successful search, then ping and unchanged tools/list. Its arguments, results and JSON-RPC error codes appear in the
context preview and `mcp-probe.json`; `protocol-events.ndjson` preserves attempts
incrementally. These exchanges are separate from the configured-tool attempt count.
No native client prompt is involved.

The installed SDK currently reports an unknown tool with `isError: true`, whereas
the [MCP error-handling specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#error-handling)
describes a JSON-RPC error. The audit records this compatibility note explicitly;
passing recovery is not full specification conformance. Operational tool failures
now require `isError: true` with useful text. The SDK audit explicitly distinguishes
a known-tool failure from an empty successful response, including when Pi’s bridge
converts MCP errors into native exceptions. Cancellation, exhaustive wire
fuzzing and unsupported protocol-version negotiation remain outside this smoke suite.
