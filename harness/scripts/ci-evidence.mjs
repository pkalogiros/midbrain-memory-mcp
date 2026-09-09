// Finalize a CI run without exposing its private logs, homes, or credentials.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportBundle, verifyBundle } from './release-evidence.mjs';
import { collectSecrets } from '../lib/env.mjs';

export function collectCiEvidence({ root, output, sha, suite, secrets = [] }) {
  if (!/^[a-f0-9]{40}$/.test(sha) || !['smoke', 'required'].includes(suite)) throw new Error('Invalid CI source SHA or suite');
  fs.mkdirSync(output, { recursive: true });
  const summary = [`# Behavioral ${suite} run`, '', `Source: \`${sha}\``, ''];
  let verified = false;
  let bundle = false;
  let error = false;
  try {
    const runs = path.join(root, 'runs');
    const entries = fs.existsSync(runs) ? fs.readdirSync(runs).filter(n => /^\d{8}-\d{6}-[a-f0-9]{4}$/.test(n)) : [];
    if (entries.length !== 1) throw new Error('Expected exactly one run');
    const run = path.join(runs, entries[0]);
    if (!fs.existsSync(path.join(run, 'results.json'))) {
      summary.push('**INCOMPLETE — no completed report.** No private or partial evidence was uploaded.');
      error = true;
    } else {
      const destination = path.join(output, 'bundle');
      exportBundle(run, destination, secrets);
      bundle = true;
      const results = JSON.parse(fs.readFileSync(path.join(run, 'results.json'), 'utf8'));
      // Checkpoints still have integrity/source checks performed by verifyBundle.
      const problems = verifyBundle(destination, results.candidate.tarball, sha);
      const counts = {};
      for (const cell of results.cells) counts[cell.status] = (counts[cell.status] || 0) + 1;
      summary.push(['PASS', 'FAIL', 'BLOCKED', 'SKIP'].map(s => `${s}: ${counts[s] || 0}`).join(' · '), '');
      verified = problems.length === 0;
      summary.push(verified ? '**Required behavioral gate verified.** Programmatic CI and release review remain separate.' : '**CHECKPOINT — not release sign-off.** See the bundle for individual checks.');
    }
  } catch {
    // Parser and filesystem errors can contain private data. Fail closed and report only status.
    fs.rmSync(path.join(output, 'bundle'), { recursive: true, force: true });
    bundle = false;
    error = true;
    summary.push('**Evidence collection failed.** No bundle was uploaded; inspect the runner before teardown if private diagnostics are needed.');
  }
  if (suite === 'required') summary.push('', 'Unattended Codex native hook approval is not implemented. That case remains BLOCKED; it is never waived.');
  fs.writeFileSync(path.join(output, 'summary.md'), summary.join('\n') + '\n');
  return { verified, bundle, error };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const state = collectCiEvidence({ root: process.env.MIDBRAIN_HARNESS_ROOT, output: process.env.MIDBRAIN_CI_ARTIFACTS, sha: process.env.GITHUB_SHA, suite: process.env.MIDBRAIN_CI_SUITE, secrets: Object.values(collectSecrets()) });
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `verified=${state.verified}\nbundle=${state.bundle}\n`);
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, fs.readFileSync(path.join(process.env.MIDBRAIN_CI_ARTIFACTS, 'summary.md')));
  process.exitCode = state.error ? 1 : 0;
}
