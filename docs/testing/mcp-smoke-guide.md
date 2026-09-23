# Three ways to test the MCP

The [standalone HTML guide](mcp-smoke-guide.html) opens directly from disk:
double-click it or drag it into your browser. Its content, styles and scripts
are embedded; no web server or internet connection is needed to read it.
You can share the HTML file alone. Reference links are optional. Copy buttons
fall back to selecting text if clipboard access is unavailable; press Ctrl+C
or ⌘C. The page also supports browser printing and stays readable without JavaScript.

## Choose a mode

| Mode | What it checks | Model inference cost |
|---|---|---|
| **Dry-smoke** | Direct MCP contracts across all 12 tools, schemas, configuration, credentials and failures; separate native client connection/discovery | **$0** |
| **Scripted-smoke** | A local provider simulator directs the real client through all 12 tools, a 503 failure and recovery; native events, MCP traces and backend receipts must agree | **$0** |
| **Live-smoke** | Real models and clients perform a requested search and consume its result, then handle an error and recover, in two fresh sessions per client | Usage-based; illustrative estimates below |

All three use a synthetic API. No Docker, MidBrain deployment or real MidBrain
API key is required. They test MCP integration, not production memory quality.
Scripted decisions do not prove model judgment; live-smoke tests requested tool
use, not spontaneous tool selection. Your machine, CI runner and downloads may
still have infrastructure costs.

The clients are **Claude Code, Codex, Pi, OpenCode and Hermes**. The harness
launches them automatically in an isolated test home.

## Run it

From the repository checkout, with Node 20+, npm and Git:

```bash
git switch mcp-testing-layers
npm ci
```

Claude and Codex must already be on `PATH`. `--install-clients` installs missing
Pi, OpenCode and Hermes inside the run directory; Hermes needs `uv`. Installation
may require network access. Neither dry-smoke nor scripted-smoke loads provider
credentials or needs API keys.

### Dry-smoke

```bash
node harness/run.mjs dry-smoke --clients claude,codex

# Omit --clients for all five:
node harness/run.mjs dry-smoke --install-clients
```

Flow: harness → installed MCP → fixture API; native discovery is a separate check.

### Scripted-smoke

Select **one client per run**:

```bash
node harness/run.mjs scripted-smoke --clients claude
node harness/run.mjs scripted-smoke --clients codex
node harness/run.mjs scripted-smoke --clients pi --install-clients
```

Flow: local script → real client → MCP → fixture API → result back to the local
script. Each run has a 90-second native deadline. Claude, Codex, Pi and Hermes
run 14 MCP calls; OpenCode adds a fifteenth call to a second server to verify
same-name tool routing.

### Live-smoke

First print a plan. This does not launch model sessions:

```bash
node harness/run.mjs live-smoke \
  --config harness/live-smoke.example.json \
  --clients claude,codex
```

The example config selects GPT-6 Luna for Codex/OpenCode and Haiku 4.5 for
Claude Code/Hermes/Pi. Claude uses its native Anthropic path; there is no Luna bridge.

To run the pair, supply `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` through the
environment or private `harness/.env`, then explicitly add `--execute`:

```bash
node harness/run.mjs live-smoke \
  --config harness/live-smoke.example.json \
  --clients claude,codex \
  --execute
```

That starts four native sessions and can incur charges. Two sessions per client
can involve several provider requests. A failed first scenario skips that
client's second paid scenario. Paid validation is still pending: no real-model
live-smoke pass or measured cost has been recorded.

## Arguments

| Argument | Modes | Meaning |
|---|---|---|
| `--clients` | All | Comma-separated names for dry/live; exactly one for scripted. Defaults: all five for dry, Pi for scripted, config clients for live. |
| `--install-clients` | All | Install missing Pi/OpenCode/Hermes under the run. Claude/Codex must be preinstalled. |
| `--root DIR` | All | Output root; defaults to `~/.midbrain-harness` unless `MIDBRAIN_HARNESS_ROOT` is set. |
| `--config FILE` | Live | Required JSON model configuration. |
| `--execute` | Live | Make real model calls. Omit it to print a plan; `--plan` explicitly selects the default. |

Live `timeoutMs` and `maxMcpCalls` are JSON fields, not CLI flags. Defaults are
90,000 ms and four MCP calls per session; allowed ranges are 10,000–180,000 ms
and 2–8 calls. These controls are **not a hard dollar cap**. Dry/scripted reject
model and live-provider flags.

## Illustrative live costs

These are **token calculations, not measured run costs**. Assume **50,000 input
tokens plus 5,000 output tokens per client, total across both sessions and all
model rounds**. Standard direct API prices checked 23 September 2026:

| Client / model | Input / output per million tokens | Two-session estimate |
|---|---|---|
| Codex / GPT-6 Luna | $0.10 / $0.50 | $0.0075 |
| OpenCode / GPT-6 Luna | $0.10 / $0.50 | $0.0075 |
| Claude Code / Haiku 4.5 | $1.00 / $5.00 | $0.075 |
| Hermes / Haiku 4.5 | $1.00 / $5.00 | $0.075 |
| Pi / Haiku 4.5 | $1.00 / $5.00 | $0.075 |
| **All five / 10 sessions** | Same assumptions per client | **About $0.24** |

Sources: [OpenAI pricing](https://developers.openai.com/api/docs/pricing) and
[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing).
Formula: `(input tokens × input rate + output tokens × output rate) / 1,000,000`.

Repeated context, tool definitions, retries and billed reasoning can change
the token totals. Twice the assumed tokens gives about $0.48 across all five.
Examples exclude caching discounts/write premiums, long-context or processing-tier
premiums, taxes and infrastructure. Reports preserve native usage and reported
cost where available; missing accounting stays **unreported**.

## Results and logs

Executed runs print a `report.html` path. Open it directly in your browser.
Outputs normally live under `~/.midbrain-harness/runs/<run-id>/` and include
HTML, Markdown, JSON, JUnit, candidate hashes, client versions, host information
and watched-file isolation checks.

- **Dry:** MCP context preview with definitions, arguments and direct-probe results.
- **Scripted:** actual client requests to the local provider simulator, with synthetic credentials redacted.
- **Live:** native tool events, MCP exchanges, backend receipts and available usage; full provider request logging is not guaranteed.

PASS means the checks agree; FAIL means an assertion failed; BLOCKED means a
prerequisite is missing; INCOMPLETE means the run did not finish. Failed, blocked
and incomplete runs exit nonzero. Missing tools do not silently pass. Ctrl+C
stops owned processes and retains available evidence; a hard kill may leave
partial logs. A final answer claiming success cannot substitute for tool receipts.

## Validated scope

[Recorded Linux/macOS CI](https://github.com/pkalogiros/midbrain-memory-mcp/actions/runs/35875387911)
passed all 12 native jobs at commit `6c29a38`: dry-smoke across five clients and
scripted-smoke for each client on both hosts, with 1,026 passing assertions.
Native Windows and paid live-smoke remain unvalidated.

These modes do not establish memory ranking, production service reliability,
capture correctness or every third-party conflict. Test homes and watched-file
checks are not an OS network sandbox.

Further references: [dry-smoke](dry-smoke.md), [scripted-smoke](scripted-smoke.md),
[live-smoke](live-smoke.md), [full harness guide](harness-how-it-works.md).
