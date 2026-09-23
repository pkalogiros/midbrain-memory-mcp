# Export and verify an MCP review bundle

Use the existing harness to assemble recorded **dry-smoke and scripted-smoke**
runs into one portable review directory. Export makes no model calls, launches
no clients, reads no credential files, and leaves the source runs unchanged.

```bash
node harness/run.mjs review-bundle /path/to/dry-run /path/to/pi-run /path/to/opencode-run --output /path/to/new-review
node harness/run.mjs verify-review /path/to/new-review
```

The output's parent directory must exist. The output directory must be new and
outside every source run. Select 1–20 runs; passing, failed, blocked and interrupted
runs are supported. Live-smoke and behavioral results are rejected by this
synthetic-evidence exporter. The existing behavioral release-evidence workflow
remains separate.

Open `index.html` to compare each run's native clients, recorded host, assertion
counts and test outcome. Each row links to the complete offline HTML report.
The directory can be zipped or copied for handoff without its original run homes.

## What is included

- An offline overview and review notes.
- Per-run JSON results, regenerated HTML/Markdown reports, JUnit, candidate
  identity and host-isolation results.
- An explicit selection of synthetic MCP, provider, native-client, peer-server
  and installer evidence. Linked evidence must exist; unsafe references fail export.
- A manifest with file sizes, SHA-256 hashes and source-file hashes for redacted
  evidence. Original report HTML is not copied or executed.

Private test homes, client configuration, credential files, binaries, candidate
source, dependency caches and databases are excluded. The exporter redacts fixture
keys, structured credential values and common credential formats while preserving
tool-schema definitions. Inspect fixture text before distribution: arbitrary
secrets manually inserted into free text are not guaranteed to be recognized.

Symlinked evidence, path traversal, oversized files, duplicate sources, missing
linked evidence and an existing output directory are rejected. Export stages the
files, verifies them and publishes the directory only after verification succeeds.

## Integrity and test success are separate

`verify-review` exits zero when the bundle passes inventory, hash, report-summary
and link checks. Changed, missing, unlisted or unsafe files cause a nonzero exit.
The JSON output also reports the original test outcome of each run.

A valid bundle can contain **FAIL**, **BLOCKED** or **INCOMPLETE** tests. The
exporter does not convert those outcomes to PASS. Verification does not rerun the
tests, authenticate the author, certify a release or establish other-OS coverage.
Checksums detect changes relative to the manifest; use a trusted channel when
obtaining the bundle and its manifest.

The exporter verifies a staging directory, reserves a new destination exclusively,
and moves its contents with the manifest last. This supports Windows directory
semantics and leaves interrupted publication unverifiable. Existing destinations
are refused; a caught publication failure removes only the newly reserved output.
