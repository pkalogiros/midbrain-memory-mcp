# Scripted-smoke: native MCP execution without LLM inference

This mode extends the existing harness. It packages the candidate, runs the real
installer in an isolated home, launches **real Pi, OpenCode or Hermes**, and gives it a loopback
OpenAI-compatible endpoint. That endpoint returns predetermined tool calls instead
of running a model. The native client dispatches them through the installed MCP integration and
sends the tool results back. The synthetic backend stores no memories.

```bash
npm ci
node harness/run.mjs scripted-smoke --clients pi --install-clients
node harness/run.mjs scripted-smoke --clients opencode --install-clients
node harness/run.mjs scripted-smoke --clients hermes --install-clients
# Reuse an installed Pi and select the report root:
node harness/run.mjs scripted-smoke --root /tmp/midbrain-scripted-smoke
```

Node 20+, npm and Git are needed. `--install-clients` installs the missing selected client in the
run directory; set `MIDBRAIN_HARNESS_PI_VERSION` or
`MIDBRAIN_HARNESS_OPENCODE_VERSION` or `MIDBRAIN_HARNESS_HERMES_VERSION` to pin its version. Hermes installation also needs `uv`. Existing binaries are reused with an isolated home. The mode does not load `.env`, copy
login files or pass provider credentials. Only dummy and synthetic keys are used.
Package/client downloads can use the network: this is not an OS network sandbox.

## What it proves

| Boundary | Required evidence |
|---|---|
| Installation | Real candidate installer succeeds; product adapter recognizes the selected client’s fresh integration; command points to the frozen package |
| Discovery and provider context | All 12 tools appear in the client's actual outgoing provider request with the reviewed schemas |
| Dispatch | Scripted tool name, arguments and call ID match native client events and the MCP recorder |
| Result delivery | The actual MCP response matches the native result and appears in the correlated tool-result message sent back to the provider |
| HTTP contract | Synthetic backend observes expected paths, query parameters, account bodies and credential scope |
| Local writes | Account selection and project setup produce the expected synthetic project credentials |
| Failure recovery | HTTP 503 is returned to the native client and then the provider; a subsequent call succeeds on the same MCP connection |
| Isolation and reproducibility | Watched real-home files remain unchanged; frozen package and harness hashes remain unchanged |

All 12 tools run once on their positive path. `memory_search` additionally runs
the outage and recovery pair: **14 tool calls and 15 local completion requests** in
one native Pi or Hermes session. OpenCode adds a fifteenth call to an independent peer MCP
server, bringing its total to **15 tool calls and 16 local completion requests**.
The provider does not advance on missing/mismatched schemas,
call IDs or result content. Positive calls cannot pass with error envelopes.
No answer-only assertion substitutes for transport evidence.

The injected HTTP 503 must carry `isError: true` and useful error text. The test
checks the HTTP receipt, MCP error flag, native failure and returned provider context,
then requires a successful retry on the same MCP connection.

## Limits and failure handling

- Pi, OpenCode and Hermes are supported, **one client per run** (default: Pi). Other
  clients, combined client selections and unsupported flags are
  rejected before preparation. There is no silent substitute for native execution.
- A missing selected client or an unsupported host is BLOCKED. Use `--install-clients` for a
  run-local installation. Pi and Hermes drivers support macOS/Linux; the OpenCode driver also allows Windows,
  but native Windows validation has not been recorded.
- The native session has a 90-second deadline, plus process cleanup time. The MCP
  recorder permits at most 14 calls for Pi/Hermes or 15 for OpenCode, shared
  across all instrumented MCP processes and reconnects. The provider accepts at
  most 15 completion requests for Pi/Hermes or 16 for OpenCode, with a 4 MiB request-body limit. Hermes additionally permits up to 16 local capability-discovery GETs. They are logged and counted separately from completion requests; unexpected completion requests fail the run.
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
- `native-session.jsonl`: Hermes’s native session export, correlated to the exact test prompt; result trust wrappers are retained in raw evidence.
- `mcp-events/*.ndjson`: MCP discovery, attempted calls and results.
- `peer-events.ndjson`: OpenCode’s independent peer-server request/result receipt.

Synthetic credentials are redacted in reports and linked evidence. Keep private
test homes out of review bundles. Run `node harness/run.mjs report <run-directory>`
to regenerate presentation files without rerunning the native test.

## How to use the layers

| Mode | Native evidence | LLM inference | Scope |
|---|---|---|---|
| `dry-smoke` | Connection/discovery across five clients, direct harness-driven MCP calls | None | All-tool contracts and failure handling |
| `scripted-smoke` | Actual Pi/OpenCode/Hermes tool-dispatch and result-return loop | None | All-tool native routing, provider context, outage/recovery |
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
| Pi 0.87.1 | `20260923-062419-446a` | 25/25 | 14 | 15 completion requests |
| OpenCode 1.18.32 | `20260923-062423-ddfd` | 28/28 | 15 | 16 completion requests |
| Hermes 0.19.0 | `20260923-062426-eac1` | 25/25 | 14 | 15 completion requests + 10 capability GETs |

The `MCP integration (no models)` workflow is configured for Pi/OpenCode/Hermes × Linux/macOS on relevant pushes and pull requests, or manual dispatch. [Remote CI passed all eight Linux/macOS native jobs](https://github.com/pkalogiros/midbrain-memory-mcp/actions/runs/35867643216) for commit `15f93a4`, including scripted Pi, OpenCode and Hermes on each host. Native Windows execution remains unvalidated.

Hermes uses its custom-provider setting with a loopback URL, automatic compression disabled and the full tool catalog enabled (`tool_search: off`). Its native session export proves dispatch independently of provider receipts. This does not test Hermes deferred tool discovery. Pi and Hermes do not yet run OpenCode’s second-server collision scenario.

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

Current reports include `assertionSchemaVersion: 1`. The gate requires every
expected assertion ID exactly once in its correct coverage row, with a boolean
passing result. Missing, duplicate or unknown assertions cannot produce PASS.
Older saved reports retain their original evidence rules; they do not gain checks
that were added after they ran.
