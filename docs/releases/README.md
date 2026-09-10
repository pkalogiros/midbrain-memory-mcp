# Release Notes

This directory stores the public release-note archive for
`midbrain-memory-mcp`.

Each release can have three files:

- `vX.Y.Z.md`: full GitHub Release body source, with TLDR first.
- `vX.Y.Z-light.md`: shorter announcement draft.
- `vX.Y.Z-tldr.md`: shortest digest.

## Release validation checklist

For changes covered by the multi-client harness:

1. Select the release source SHA, candidate archive and pinned client/model configuration.
   Run programmatic CI for that source; retain the passing OS jobs in the release review.
2. Run `node harness/run.mjs run --mode registry --upgrade --required --interactive`
   against a healthy dedicated test API. `--interactive` uses a terminal for native
   Codex approval; `--approve-codex-hooks` can instead drive the pinned native UI
   (see the workflow guide for its validation boundary).
3. Export the completed run using
   `node harness/scripts/release-evidence.mjs export <run> <new-bundle>`.
   Review the redacted bundle before attaching it to the release review; never upload the run home.
4. Run `node harness/scripts/release-evidence.mjs verify <bundle> <release.tgz> <full-source-sha>`.
   Require exit 0. This checks the complete behavioral gate and matches the exact intended
   release archive. An RC-only report does not approve a stable-version repack.
5. Obtain Radu's product review, including the
   [four harness-discovered product changes](../testing/multi-client-harness.md#release-review-for-the-hardening-changes).
   Record remaining coverage boundaries from the [coverage map](../testing/multi-client-harness.md#5-behavioral-coverage-and-prompt-ownership).
6. Publishing remains a separate authorized release action. The manual
   [behavioral workflow](../testing/behavioral-ci.md) is built but not deployed or cloud-validated;
   unattended native Codex approval is implemented but still needs Linux validation. It does not enforce product review or
   publishing, and no real-npm post-publish upgrade smoke mode exists yet.

Focused passes and incomplete/blocked reports are checkpoints, not release approval.

Latest releases:

- [v0.4.10 full](v0.4.10.md), [light](v0.4.10-light.md), [TLDR](v0.4.10-tldr.md)
- [v0.4.9 full](v0.4.9.md), [light](v0.4.9-light.md), [TLDR](v0.4.9-tldr.md)
- [v0.4.8 full](v0.4.8.md), [light](v0.4.8-light.md), [TLDR](v0.4.8-tldr.md)
- [v0.4.7 full](v0.4.7.md), [light](v0.4.7-light.md), [TLDR](v0.4.7-tldr.md)
- [v0.4.6 full](v0.4.6.md), [light](v0.4.6-light.md), [TLDR](v0.4.6-tldr.md)
- [v0.4.5 full](v0.4.5.md), [light](v0.4.5-light.md), [TLDR](v0.4.5-tldr.md)
- [v0.4.4 full](v0.4.4.md), [light](v0.4.4-light.md), [TLDR](v0.4.4-tldr.md)
- [v0.4.3 full](v0.4.3.md), [light](v0.4.3-light.md), [TLDR](v0.4.3-tldr.md)
- [v0.4.2 full](v0.4.2.md), [light](v0.4.2-light.md), [TLDR](v0.4.2-tldr.md)
- [v0.4.1 full](v0.4.1.md), [light](v0.4.1-light.md), [TLDR](v0.4.1-tldr.md)
- [v0.4.0 full](v0.4.0.md), [light](v0.4.0-light.md), [TLDR](v0.4.0-tldr.md)
