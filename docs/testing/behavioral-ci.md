# Behavioral workflow setup

[behavioral.yml](../../.github/workflows/behavioral.yml) is built for manual GitHub Actions
runs. It has not been deployed, dispatched, or validated on a cloud runner. The existing
programmatic CI remains separate.

Local validation (2026-09-09): the native approval driver passed against Codex 0.150.1
in six fresh macOS homes, using a placeholder key and no model prompts. It rejects
already-trusted hooks; scenario tests retain both capture checks and reject failed approval.
`MIDBRAIN_TEST_CODEX_APPROVAL=1 VITEST_MAX_WORKERS=4 npm run check` passed
(1,324 tests plus 224 copied-topology isolation checks); actionlint
1.7.12 and Bash syntax checks for all eight shell steps passed. This supersedes the earlier
local timeout/drift checkpoint. Linux execution and a full unattended required run remain
unvalidated. Reproduce the optional native CLI check with:

```sh
MIDBRAIN_TEST_CODEX_APPROVAL=1 npx vitest run tests/harness-codex-approval.test.mjs
```

## What the button will do

Choose a branch, suite and Anthropic model in **Actions → Behavioral tests → Run workflow**.
GitHub only exposes manual dispatch after the workflow exists on the default branch.
See [GitHub's manual-run documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

| Suite | Command | Interpretation |
|---|---|---|
| `smoke` (default) | `run --mode registry --scenarios s01,s06` | All five clients: capture and answer cleanliness. A green smoke is a checkpoint, not release approval. |
| `simple` | `run --mode registry --upgrade --simple --approve-codex-hooks` | All scenarios, with five cross-client links in a cycle instead of twenty ordered pairs. A green simple run is reduced-coverage validation, not full required sign-off. |
| `required` | `run --mode registry --upgrade --required --approve-codex-hooks` | Complete matrix with upgrades and native Codex approval automation. Requires a passing complete report before release sign-off. |

Simple mode saves thirty cross-client prompts with five clients. It preserves the other
scenario checks and records the cycle in the report and evidence bundle. Use it for broader
iteration after smoke; only `required` establishes the existing exhaustive release gate.
The selection logic and evidence handling are unit-tested; a live simple matrix remains unvalidated.

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

## Current self-hosted runner setup

These settings describe the checked-in workflow. Self-hosting is its current configuration;
real client binaries, Docker and a run root outside `/tmp` do not by themselves establish
that a GitHub-hosted VM is unsuitable. The hosted-runner trial below is proposed work.

1. Register a dedicated Linux runner with labels `self-hosted`, `linux`, `midbrain-behavioral`.
   Install Git, Bash, tar, Python 3, npm prerequisites, uv, and working Docker. Node is installed by the
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

## Deployment sequence (proposed)

1. Adapt the workflow for a GitHub-hosted `ubuntu-24.04` trial, explicitly installing
   prerequisites such as `uv`. Validate CPU, memory and disk capacity, Docker, the NanoClaw
   image and network paths, and the offline native Codex approval check before model calls.
   Measure whether a larger hosted runner is needed. This adaptation has not been made;
   the existing YAML still requires the self-hosted labels above.
2. Choose a healthy staging MidBrain API reachable from both the VM and NanoClaw containers.
   Configure the environment variable and four secrets listed above. The workflow does not
   provision the backend, create test agents or expose an API running on a developer's laptop.
3. Add an optional final Slack notification using an environment secret named
   `SLACK_WEBHOOK_URL`. Include the suite, candidate commit, outcome and GitHub run link;
   distinguish smoke success from required-gate success and handle failure/cancellation.
   Notification delivery must not replace the test verdict. Slack support is not yet built.
4. After review and explicit authorization, push and merge the workflow to the default
   branch, then run prerequisite checks and smoke first. Check uploaded redacted artifacts,
   cleanup and notification delivery. Keep manual triggering while validating the rollout.
5. Triage the existing behavioral failures using saved evidence and targeted reruns, then
   run the complete required matrix on the intended candidate. Require clean isolation,
   every required check passing, and matching evidence. Retain the tested archive privately
   if it will be needed for later release verification; current cleanup deletes it.

The button is operational when execution, evidence, cleanup and reporting work on the
chosen runner. Release sign-off additionally requires the passing required matrix,
programmatic CI and Radu's product review. The latest broad behavioral checkpoint was
108 PASS / 16 FAIL / 1 BLOCKED on `6d6fc58`, not a passing required result; see the
[coverage and validation boundary](multi-client-harness.md#implemented-versus-validated).

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
unattended release gate still needs validation on Linux. `--approve-codex-hooks` checks
the exact three installed definitions through Codex, drives its native hook browser through
a Python 3 standard-library PTY, and checks persisted trust in a fresh Codex process.
The scenario still requires no capture before approval and capture afterward without
the bypass. A changed client version, unexpected hook, UI timeout, or changed hash fails
closed. Only the selected approval receipt enters the evidence bundle; raw terminal
output remains private. No trust file is fabricated and no cell is waived.
