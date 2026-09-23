# Live-smoke: verify native model-to-MCP tool execution

`live-smoke` extends the existing harness with two small model-backed scenarios per
selected client. It answers: **can a model inside this native client call our MCP
and receive its result?** It uses a frozen candidate, isolated home, real installer,
native client launcher, and a local synthetic API. It does not run the memory
engine, embeddings, indexing, or retrieval-quality tests.

## Choose the right layer

| Mode | Model calls | Backend | Question answered |
|---|---|---|---|
| `dry-smoke` | None | Synthetic local API | Do installation, MCP contracts, recovery and native discovery work? |
| `live-smoke` | Two bounded native sessions per client | Synthetic local API | Does an explicitly requested tool call execute through the native client and deliver its result? |
| Existing behavioral suites | Multiple sessions/models | Real MidBrain service | Do capture, recall, continuity and other memory behaviors work? |

The existing `--model-checks` profile still tests memory behavior. It is separate
from this new mode. Live-smoke does not replace the broader deterministic coverage
of dry-smoke; run both when collecting integration evidence.

## Prepare and inspect the plan

```bash
npm ci
node harness/run.mjs dry-smoke --clients claude,codex
node harness/run.mjs live-smoke --config harness/live-smoke.example.json --clients claude,codex
```

Without `--execute`, live-smoke only prints its plan. It does not load `.env`,
launch clients, install packages or make model requests. `--plan` is also accepted.
The plan shows the selected models, number of scenarios, required provider keys,
deadline and MCP call cap.

The checked-in example includes all five clients:

| Client | Explicit model | Credential |
|---|---|---|
| Claude Code | `claude-haiku-4-5` | `ANTHROPIC_API_KEY` |
| Codex | `gpt-6-luna` | `OPENAI_API_KEY` |
| OpenCode | `openai/gpt-6-luna` | `OPENAI_API_KEY` |
| Hermes | `claude-haiku-4-5` | `ANTHROPIC_API_KEY` |
| Pi | `claude-haiku-4-5` | `ANTHROPIC_API_KEY` |

Selecting `--clients claude,codex` produces four bounded sessions: call-and-consume
and error-and-recovery for each client. Both clients also belong to the default
dry-smoke matrix; `dry-smoke --clients claude,codex` narrows that zero-model run.

Luna is the OpenAI model selection; it is not the name of the testing mode.
Claude Code, Hermes and Pi use the existing Anthropic launcher path. Running
Claude Code against Luna would require a protocol bridge, which this live-smoke
path does not implement. Codex uses OpenAI API-key authentication, without copying
your normal client login. OpenCode accepts explicit `anthropic/model-id` or
`openai/model-id` selections. Model/account access still needs live validation.

Unknown settings, missing models, duplicate clients, `latest` model selections,
and production API/model-sweep/upgrade flags are rejected. Selecting fewer clients
reduces the run rather than silently skipping missing prerequisites.

## Execute deliberately

```bash
# Requires ANTHROPIC_API_KEY and OPENAI_API_KEY in the environment or harness/.env.
node harness/run.mjs live-smoke \
  --config harness/live-smoke.example.json \
  --clients claude,codex \
  --execute

# OpenCode, Hermes and Pi may be installed into the isolated run directory.
node harness/run.mjs live-smoke \
  --config harness/live-smoke.example.json \
  --install-clients --execute
```

`--execute` makes real provider requests and can incur charges. No MidBrain API key,
deployment or Docker is required. Codex needs `OPENAI_API_KEY`; the Anthropic paths
need `ANTHROPIC_API_KEY`. OpenCode uses the key matching its configured provider.
Only the selected client's provider credential is passed into its worker. The
MCP child does not inherit provider credentials. Real-home login/config files are
not copied, and the existing real-home tripwire checks for drift afterward.

All selected binaries, OS support and required credentials are checked before any
model session starts. Credential presence is not proof that a provider accepts it
or that the selected model exists. Provider rejection remains visible as a failed
native attempt. Missing prerequisites block the run with zero model attempts.

## The two scenarios

1. **Call and consume.** In a fresh native session, explicitly request
   `memory_search` with an exact opaque query, `memory_type: "semantic"` and
   `limit: 1`. The synthetic API returns a fresh, unpredictable verification value.
   The final answer must include that value.
2. **Error and recovery.** In another fresh native session, request one exact query
   that receives HTTP 503 with a fresh error marker. Then request a second query
   that succeeds. The native session must remain usable and return the successful
   verification value. Both tool calls must appear in order in the evidence.

Verification values are generated in runner memory and omitted from prompts and
pre-turn input files. They are written into the final evidence only after the
attempt. The fixture holds no memories. The MCP's normal semantic overfetch and
recency-peek behavior are accounted for explicitly; no retrieval engine is used.

These are explicitly directed integration tasks. They do not measure whether a
model spontaneously chooses the right tool for an ordinary user request.

## What counts as a pass

Each scenario requires all four evidence sources to agree:

- **Native events:** the actual client records the intended MidBrain tool, exact
  arguments, and returned verification/error value.
- **MCP transport:** a stdio recorder forwards the installed candidate's tool
  definitions and responses unchanged and logs the corresponding calls/results.
- **Fixture HTTP:** requests arrive on the expected endpoint with the expected
  transformed parameters, synthetic credential and HTTP outcome.
- **Final answer:** the successful verification value reaches the answer.

An answer alone cannot pass. Shell/file/web tools used as substitutes, wrong
arguments, unknown tool namespaces, missing records, duplicate calls, unfinished
responses, damaged logs, timeouts, unexpected backend requests and failed processes
fail the scenario. Native tool discovery is allowed before the requested calls.
All 12 tools remain discoverable, but the smoke recorder permits execution only
of `memory_search`; other MCP invocations fail the scenario and stop that transport.
This recorder changes the launch path and limits execution; it is instrumentation,
not a claim that an uninstrumented session behaves identically in every respect.

Native hooks/plugins remain installed. Known capture writes are acknowledged by
the fixture and immediately discarded. Recency peeks receive an empty response.
Both are recorded separately; neither is proof of capture or memory correctness.

## Limits, failures and cost

The configuration accepts `timeoutMs` (10–180 seconds, default 90 seconds) and
`maxMcpCalls` (2–8, default 4). The call budget is shared across MCP reconnects
within one scenario. Extra calls fail the score even if below the emergency cap.
The worker deadline stops the native process group; forced cleanup can add up to
five seconds. Windows process-tree cleanup and native client compatibility need
separate validation; Hermes/Pi drivers currently support macOS/Linux only.

There are no harness retries, model fallbacks, model sweeps or automatic expensive
model substitutions. If the first scenario fails, the second paid scenario for
that client is not started. Independent selected clients can still be checked.
Ctrl+C retains available evidence and an incomplete, nonzero result.

Two sessions do **not** mean two provider requests. Native clients can make multiple
model rounds and internal retries. Time and MCP-call limits are not hard token or
dollar caps. The report preserves native usage and reported cost when available;
missing values remain unreported. It does not apply the behavioral harness's
historical price estimates or claim the subtotal is a complete invoice. Use a
provider-side spending limit when an enforceable financial cap is required.

PASS requires every selected client's installation and both scenarios, nonempty
passing assertions, a completed run and clean host isolation. FAIL, BLOCKED and
INCOMPLETE all exit nonzero. A BLOCKED second scenario is not silently counted as
a pass. The report distinguishes requested models from any model identity actually
exposed by the native receipt.

## Review and share evidence

Every run writes `report.html`, `report.md`, `results.json`, `junit.xml`, candidate
identity and `isolation.json`. The offline HTML report includes:

- Client/version/model coverage and strict scenario verdicts.
- Native-session counts, deadlines, call caps and explicitly partial cost coverage.
- Searchable sessions with prompts, final answers, assertions, native calls,
  observed MCP tool definitions and arguments/results, and HTTP receipts.
- Direct session links, expandable raw evidence and print support.

Per-scenario evidence lives under `evidence/<client>/round-trip/` and
`evidence/<client>/recovery/`: the prompt, worker/native artifacts, incremental
`mcp-events/*.ndjson`, and a combined `receipt.json`. Expected values are retained
there for auditing. These are **observed native and MCP receipts**, not a full
capture of provider requests, hidden system prompts or provider tokenization.

Configured provider keys and the synthetic API key are redacted before artifacts
are linked into the finished report. Raw native artifacts can exist inside the
private run directory during execution; a hard kill can interrupt final redaction.
Share the completed reports and reviewed evidence, not isolated homes, login files,
dependencies or an entire interrupted run directory.

Regenerate presentation without any model calls:

```bash
node harness/run.mjs report /path/to/run
```

## Validation status

The automated tests exercise the scorer's false-pass defenses, actual MCP transport
and fixture behavior, shared call budgets, and the full runner using a simulated
native CLI. That simulation makes no provider requests and is not a real-model
compatibility result. The POSIX CLI simulation is skipped on Windows.

**A paid native live-smoke validation has not yet been recorded.** The next validation
step is one explicitly selected inexpensive model/client, followed by the remaining
clients and native Linux/macOS runners. Do not present the implementation tests as
proof that every provider/model/client combination already passed.

## OpenCode accounting and model selection

OpenCode's main and small-model settings are both pinned to the explicit selection,
with only that provider enabled. Title/summary agents and automatic compaction are
disabled for this focused run. The native `step_finish` receipts retain per-step
token counts and client-reported cost, deduplicated by step ID. Missing cost stays
unreported; interrupted execution is marked incomplete. These are client accounting
records, not a reconciled provider invoice or a hard dollar cap.

The checked-in Claude Haiku + Codex Luna plan and the complete five-client plan have passed zero-prompt validation. Paid
execution is pending an approved spending limit; no model pass is claimed yet.
