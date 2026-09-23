# Scripted-smoke: native MCP execution without LLM inference

This mode extends the existing harness. It packages the candidate, runs the real
installer in an isolated home, launches **real Pi, OpenCode, Hermes, Claude Code or Codex**, and gives it a loopback
provider endpoint in the client’s own wire format. That endpoint returns predetermined tool calls instead
of running a model. The native client dispatches them through the installed MCP integration and
sends the tool results back. The synthetic backend stores no memories.

```bash
npm ci
node harness/run.mjs scripted-smoke --clients pi --install-clients
node harness/run.mjs scripted-smoke --clients opencode --install-clients
node harness/run.mjs scripted-smoke --clients hermes --install-clients
# Claude Code and Codex must already be on PATH:
node harness/run.mjs scripted-smoke --clients claude
node harness/run.mjs scripted-smoke --clients codex
# Reuse an installed Pi and select the report root:
node harness/run.mjs scripted-smoke --root /tmp/midbrain-scripted-smoke
```

Node 20+, npm and Git are needed. `--install-clients` installs missing Pi, OpenCode or Hermes in the
run directory; Claude Code and Codex must already be installed. CI installs pinned versions into a temporary prefix. For run-local installers, set `MIDBRAIN_HARNESS_PI_VERSION` or
`MIDBRAIN_HARNESS_OPENCODE_VERSION` or `MIDBRAIN_HARNESS_HERMES_VERSION` to pin its version. Hermes installation also needs `uv`. Existing binaries are reused with an isolated home. The mode does not load `.env`, copy
login files or pass provider credentials. Only dummy and synthetic keys are used.
Package/client downloads can use the network: this is not an OS network sandbox.

## What it proves

| Boundary | Required evidence |
|---|---|
| Installation | Real candidate installer succeeds; product adapter recognizes the selected client’s fresh integration; command points to the frozen package |
| Discovery and provider context | All 12 raw MCP schemas match the independent contract baseline; the outgoing provider catalog matches the client-specific schema projection |
| Dispatch | Scripted tool name, arguments and call ID match native client events and the MCP recorder |
| Result delivery | The actual MCP response matches the native result and appears in the correlated tool-result message sent back to the provider |
| HTTP contract | Synthetic backend observes expected paths, query parameters, account bodies and credential scope |
| Local writes | Account selection and project setup produce the expected synthetic project credentials |
| Failure recovery | HTTP 503 is returned to the native client and then the provider; a subsequent call succeeds on the same MCP connection |
| Isolation and reproducibility | Watched real-home files remain unchanged; frozen package and harness hashes remain unchanged |

All 12 tools run once on their positive path. `memory_search` additionally runs
the outage and recovery pair: **14 tool calls and 15 local completion requests** in
one native Pi, Hermes, Claude Code or Codex session. OpenCode adds a fifteenth call to an independent peer MCP
server, bringing its total to **15 tool calls and 16 local completion requests**.
The provider does not advance on missing/mismatched schemas,
call IDs or result content. Positive calls cannot pass with error envelopes.
No answer-only assertion substitutes for transport evidence.

The injected HTTP 503 must carry `isError: true` and useful error text. The test
checks the HTTP receipt, MCP error flag, native failure and returned provider context,
then requires a successful retry on the same MCP connection.

## Limits and failure handling

- Pi, OpenCode, Hermes, Claude Code and Codex are supported, **one client per run** (default: Pi). Other
  clients, combined client selections and unsupported flags are
  rejected before preparation. There is no silent substitute for native execution.
- A missing selected client or an unsupported host is BLOCKED. Use `--install-clients` for a
  run-local Pi/OpenCode/Hermes installation; install Claude Code or Codex on PATH. Pi and Hermes drivers support macOS/Linux; the other three drivers also allow Windows,
  but native Windows validation has not been recorded.
- The native session has a 90-second deadline, plus process cleanup time. The MCP
  recorder permits at most 14 calls for Pi/Hermes/Claude/Codex or 15 for OpenCode, shared
  across all instrumented MCP processes and reconnects. The provider accepts at
  most 15 completion requests for Pi/Hermes/Claude/Codex or 16 for OpenCode, with a 4 MiB request-body limit. Hermes additionally permits up to 16 local capability-discovery GETs. Claude permits up to four HEAD `/api/hello` startup probes. These reads are logged and counted separately from completion requests; unexpected completion requests fail the run.
- The local provider never falls back to a real model. A protocol error stops the
  script; any native retry is rejected rather than advancing the test.
- Missing, mismatched, interrupted or failed evidence exits nonzero. Ctrl+C stops
  owned processes and retains an incomplete report. Incremental provider/MCP logs
  preserve received requests and attempted calls even before final scoring. Every provider
  attempt is counted, including malformed JSON, rejected retries and requests after
  completion. Bodies are retained only when read and successfully parsed; early
  rejections retain attempt metadata and reasons, without inventing a body.
- Native capture hooks remain installed. Known capture POSTs are acknowledged and
  discarded; capture correctness and memory retention are not scored.

## Evidence you can share

Each run writes `report.html`, `report.md`, `results.json`, `junit.xml`, candidate
identity and `isolation.json`. The HTML report contains expandable tool exchanges
and **actual request bodies received by the local provider**, including the native
system context, tool definitions, conversation messages and returned tool results.
This is more than dry-smoke's context preview, but it is still explicitly a local
scripted request, not evidence of an external LLM request or a model decision.

Under `evidence/<client>/scripted-smoke/`:

- `receipt.json`: script, native events, MCP trace, provider requests and HTTP receipts.
- `provider-events.ndjson`: incrementally recorded provider requests, receipts and errors.
- `native.ndjson`: native client output.
- `native-session.jsonl`: Hermes’s native session export or Codex’s native rollout. Hermes is correlated to the exact test prompt. Codex session identity, MCP completions, arguments, results and status must agree with CLI events; the rollout supplies real provider call IDs. Native wrappers are retained.
- `mcp-events/*.ndjson`: MCP discovery, attempted calls and results.
- `peer-events.ndjson`: OpenCode’s independent peer-server request/result receipt.

Synthetic credentials are redacted in reports and linked evidence. Keep private
test homes out of review bundles. Run `node harness/run.mjs report <run-directory>`
to regenerate presentation files without rerunning the native test.

## How to use the layers

| Mode | Native evidence | LLM inference | Scope |
|---|---|---|---|
| `dry-smoke` | Connection/discovery across five clients, direct harness-driven MCP calls | None | All-tool contracts and failure handling |
| `scripted-smoke` | Actual Pi/OpenCode/Hermes/Claude/Codex tool-dispatch and result-return loop | None | All-tool native routing, provider context, outage/recovery |
| `live-smoke` | Real model and native client tool use | Small, explicit run | Search invocation, result consumption, outage/recovery |
| Behavioral `run` | Real model, capture hooks and memory API | Yes | Storage, recall and cross-client behavior |

Start with dry-smoke and scripted-smoke. Use live-smoke for the remaining
real-model boundary. Its example config is plan-only until `--execute` is supplied;
costs are not hard-capped and a real-model pass has not yet been recorded. Keep
memory-quality scenarios separate from the MCP integration gate.

## Recorded native validation

These macOS arm64 runs used the packaged candidate and installed native clients, with zero LLM inference and no watched real-home drift:

| Client | Run | Assertions | MCP calls | Local provider traffic |
|---|---|---:|---:|---|
| Pi 0.87.1 | `20260923-073232-ef84` | 26/26 | 14 | 15 completion requests |
| OpenCode 1.18.32 | `20260923-073230-8276` | 29/29 | 15 | 16 completion requests |
| Hermes 0.19.0 | `20260923-073231-6cca` | 26/26 | 14 | 15 completion requests + 10 capability GETs |
| Claude Code 2.1.280 | `20260923-073232-875d` | 26/26 | 14 | 15 completion requests + 1 startup HEAD |
| Codex 0.150.1 | `20260923-073231-c802` | 26/26 | 14 | 15 completion requests |

The `MCP integration (no models)` workflow is configured for Pi/OpenCode/Hermes/Claude/Codex × Linux/macOS on relevant pushes and pull requests, or manual dispatch. [Remote CI passed all twelve Linux/macOS native jobs](https://github.com/pkalogiros/midbrain-memory-mcp/actions/runs/35875387911) for commit `6c29a38`, including all five scripted clients on each host. The downloaded reports passed review-bundle verification: 12 runs, 1,026 assertions and 248 files. Native Windows execution remains unvalidated.

Hermes uses its custom-provider setting with a loopback URL, automatic compression disabled and the full tool catalog enabled (`tool_search: off`). Its native session export proves dispatch independently of provider receipts. This does not test Hermes deferred tool discovery. Only OpenCode currently runs the second-server collision scenario.

## Claude Code and Codex provider adapters

Claude Code uses an Anthropic Messages endpoint on loopback, with automatic
compaction and tool search disabled. The script emits `tool_use` blocks, and
Claude’s actual `tool_result` blocks must return with the same IDs. Only the
MidBrain tools are pre-approved for this isolated run; built-in tools remain
visible in the provider catalog. This does not validate interactive approval or
deferred discovery.

Codex uses a custom Responses provider with no OpenAI authentication and no
provider retries. It receives a namespaced function call and executes it through
its real MCP client. The native rollout’s `McpToolCall` completion supplies the
provider call ID; CLI events independently confirm the server, arguments, result
and status. Missing or inconsistent session evidence cannot pass.

Codex’s provider-facing schema omits `minimum`, `maximum` and `default` fields.
The test checks names, types, required arguments and enums in that projection,
while separately requiring every original constraint at the raw MCP boundary.
The report retains both forms rather than claiming the provider saw constraints
that Codex removed. Codex runs with approval and hook-trust bypasses inside the
throwaway home; this validates dispatch, not its interactive trust flow.

These adapters implement only the protocol messages needed by this bounded
script. They are not general-purpose mock provider implementations. All five
adapters select tools deterministically; none proves that a real model chooses
them correctly.

## Same-name MCP coexistence

OpenCode runs with two independently launched MCP servers. Both expose a tool
named `memory_search`. The provider sees separate namespaced definitions,
`midbrain-memory_memory_search` and `scripted-peer_memory_search`. It requests
both; native events, separate process recordings and the peer's own receipt must
prove the right routing. The peer-only query must not appear in MidBrain's HTTP
requests. The test also checks that installation preserves the peer configuration.
This is one concrete collision case, not a claim about every third-party server.
Pi's adapter does not yet run this second-server scenario.

OpenCode uses its [documented compatible-provider configuration](https://opencode.ai/docs/providers),
with only the local provider enabled. Its main and small-model selections both
point there. Title/summary agents and automatic compaction are disabled to keep
this test focused and bounded. No native tools or MCP definitions are hidden to
make dispatch pass; the scripted provider explicitly selects the target tools.

## Portable review export

Combine this run with other recorded synthetic smoke runs using
`node harness/run.mjs review-bundle <run> [other-run...] --output <new-directory>`.
The export includes an offline overview and selected redacted evidence. Verify it
with `node harness/run.mjs verify-review <bundle-directory>`. A valid bundle can
contain failed or incomplete tests; integrity is separate from test success.
See [review export and verification](mcp-review-bundles.md).

Current reports include `assertionSchemaVersion: 2`, which adds a separate raw MCP schema assertion. Version 1 reports retain their original inventory. The gate requires every
expected assertion ID exactly once in its correct coverage row, with a boolean
passing result. Missing, duplicate or unknown assertions cannot produce PASS.
Older saved reports retain their original evidence rules; they do not gain checks
that were added after they ran.
