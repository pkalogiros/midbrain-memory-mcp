# Behavioral workflow setup

[behavioral.yml](../../.github/workflows/behavioral.yml) is built for manual GitHub Actions
runs. It has not been deployed, dispatched, or validated on a cloud runner. The existing
programmatic CI remains separate.

Local validation (2026-09-09): actionlint 1.7.12, Bash syntax checks for all eight shell
steps, lint and the five CI evidence tests passed. The full suite is not green in this
parallel-work session: its first attempt passed all 1,307 tests but detected host-config
drift; the final single-worker attempt passed 1,306 and hit the existing NanoClaw legacy-wake
test's five-second timeout (`tests/nanoclaw-topology.e2e.test.mjs:467`). No timeout or
isolation assertion was weakened. A clean full check and real Linux execution remain pending.

## What the button will do

Choose a branch, suite and Anthropic model in **Actions → Behavioral tests → Run workflow**.
GitHub only exposes manual dispatch after the workflow exists on the default branch.
See [GitHub's manual-run documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

| Suite | Command | Interpretation |
|---|---|---|
| `smoke` (default) | `run --mode registry --scenarios s01,s06` | All five clients: capture and answer cleanliness. A green smoke is a checkpoint, not release approval. |
| `required` | `run --mode registry --upgrade --required` | Complete matrix with upgrades. Native Codex approval currently remains BLOCKED without a terminal, so this unattended job cannot yet produce release sign-off. |

Models: Haiku 4.5 by default, or Sonnet 5 for the four Anthropic-backed clients. Codex uses
the pinned `gpt-5.6-sol` model with **OpenAI API billing**, not a personal ChatGPT login.
Check access and balance for both providers before dispatch. The readiness check verifies
credentials are present and the API is reachable; it cannot guarantee provider credit or model access.

Node 24.3.0, Claude Code 2.1.258, Codex 0.150.1, OpenCode 1.18.29, Hermes 0.19.0 and
Verdaccio 6.2.0 are pinned in the workflow. NanoClaw source/image checks come from its existing
manifest/runtime. Change pins in the workflow through code review.

The job installs Claude/Codex into a job-owned directory; OpenCode/Hermes are installed by
their existing adapters. It probes the dedicated API and Docker, runs the CLI, exports
completed evidence even when tests fail, and uploads the selected bundle plus a short summary.
Incomplete runs upload only an incomplete summary. The original failing exit status remains
red; successful export never turns a failed test green. Required runs also verify the bundle
against the checked-out source SHA and the exact run-owned tested archive.

## Provisioning needed later

1. Register a dedicated Linux runner with labels `self-hosted`, `linux`, `midbrain-behavioral`.
   Install Git, Bash, tar, npm prerequisites, uv, and working Docker. Node is installed by the
   workflow. Allow access to npm/PyPI/GitHub, image registries, provider APIs and the test API.
   Validate NanoClaw and client behavior on this Linux runner before treating it as supported.
2. Use a dedicated runner account with its home outside `/tmp` and no personal client logins
   or MidBrain configuration. Prefer a disposable VM per job; Docker uses the VM's daemon,
   so the job does not need to run inside another container. No runner image or infrastructure
   provisioning is included in this change.
3. Provide an already-running, healthy non-production MidBrain API reachable from the runner
   and NanoClaw containers. This workflow does not start or seed the sibling `memory` stack.
4. Create the GitHub environment **`behavioral-testing`**. Restrict it to trusted refs/reviewers;
   selected repository code executes with test credentials. Add the variable and secrets below.

| Environment setting | Purpose |
|---|---|
| Variable `MIDBRAIN_HARNESS_API_URL` | Explicit test API URL; no production default or credentials embedded in the URL |
| Secret `MIDBRAIN_HARNESS_API_KEY` | Dedicated global test agent |
| Secret `MIDBRAIN_HARNESS_PROJECT_API_KEY` | Different test agent for project isolation |
| Secret `ANTHROPIC_API_KEY` | Funded provider key for four clients |
| Secret `OPENAI_API_KEY` | Funded provider key for Codex |

## Evidence and cleanup

Runs are serialized across branches. There is a 195-minute suite timeout inside a 240-minute
job budget, leaving time for evidence and cleanup. Artifacts expire after 14 days. Only
`summary.md` and the exported `bundle/` are uploaded; stdout/stderr, raw transcripts, configs,
credentials and the candidate archive are not uploaded. The bundle includes its archive hash.
The verifier proves identity with this job's candidate, not with an independently selected
future release archive; release review must perform that external match separately.

Cleanup removes only this attempt's private directory and NanoClaw containers labelled with
its run ID. Raw diagnostics and the tested archive are deleted at cleanup; preserve any
needed private diagnostics through an approved runner procedure before teardown. A killed VM
or unavailable Docker daemon can prevent container cleanup; VM disposal is the final boundary.
Public tool/image caches are retained. No broad Docker prune or shared-home deletion occurs.

The workflow does not publish packages, create releases, or merge branches. A full green
unattended release gate still needs native Codex approval automation that preserves the
before/after capture checks. An approval bypass or a waived cell is not equivalent evidence.
