import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { collectCiEvidence } from '../harness/scripts/ci-evidence.mjs';
import { fileHash } from '../harness/lib/candidate.mjs';
import { ORDER, MANIFESTS } from '../harness/clients/index.mjs';
import { SCENARIOS } from '../harness/scenarios/index.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture(required = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ci-'));
  roots.push(dir);
  const root = path.join(dir, 'private');
  const run = path.join(root, 'runs/20260909-100000-abcd');
  const output = path.join(dir, 'artifacts');
  fs.mkdirSync(path.join(run, 'candidate'), { recursive: true });
  const tarball = path.join(run, 'candidate/package.tgz');
  fs.writeFileSync(tarball, 'candidate');
  const sha = 'c'.repeat(40);
  const cells = [];
  const add = (client, scenario, row) => cells.push({ client, scenario, row, status: 'PASS', checks: [{ name: 'observed', ok: true }], evidence: [] });
  for (const id of ORDER) {
    for (const sc of SCENARIOS) {
      if (sc.id === 's10-client-specific') for (const n of MANIFESTS[id].specific) add(id, `${sc.id}/${n}`, 'Client-specific scenarios');
      else for (const row of sc.rows) for (let n = 0; n < (sc.kind === 'pair' ? ORDER.length - 1 : 1); n++) add(id, sc.id, row);
    }
    for (const row of ['Clean install', 'Tool availability', 'Reproducibility']) add(id, 'derived', row);
  }
  const result = {
    run: { runId: '20260909-100000-abcd', required, finishedAt: '2026-09-09T11:00:00Z', models: Object.fromEntries(ORDER.map(id => [id, 'pinned'])) },
    candidate: { sha, shortSha: sha.slice(0, 7), mode: 'registry', dirty: false, name: 'midbrain-memory-mcp', version: '0.4.11', tarball, tarballSha256: fileHash(tarball), registry: { published: true, publishedSha256: fileHash(tarball) } },
    clients: ORDER.map(id => ({ id, displayName: id, runnable: true, version: 'pinned' })),
    cells, isolation: { ok: true, drift: [] },
  };
  return { run, result, save() { fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(result)); }, options: { root, output, sha, suite: required ? 'required' : 'smoke' } };
}

describe('CI evidence finalization', () => {
  it.each(['PASS', 'FAIL'])('exports a simple %s run as a checkpoint', status => {
    const f = fixture();
    f.result.run.simple = true;
    f.result.cells[0].status = status;
    f.result.cells[0].checks[0].ok = status === 'PASS';
    f.save();
    expect(collectCiEvidence({ ...f.options, suite: 'simple' })).toEqual({ verified: false, bundle: true, error: false });
    const summary = fs.readFileSync(path.join(f.options.output, 'summary.md'), 'utf8');
    expect(summary).toContain('Behavioral simple run');
    expect(summary).toContain('CHECKPOINT');
    expect(summary).toContain(`FAIL: ${status === 'FAIL' ? 1 : 0}`);
  });
  it('keeps a successful smoke run labelled as a checkpoint', () => {
    const f = fixture(); f.save();
    expect(collectCiEvidence(f.options)).toEqual({ verified: false, bundle: true, error: false });
    expect(fs.readFileSync(path.join(f.options.output, 'summary.md'), 'utf8')).toContain('CHECKPOINT');
  });
  it('exports completed required failures without converting them to success', () => {
    const f = fixture(true);
    f.result.cells.find(c => c.scenario.endsWith('/hook-trust-persisted')).status = 'BLOCKED'; f.save();
    expect(collectCiEvidence(f.options)).toEqual({ verified: false, bundle: true, error: false });
    expect(fs.readFileSync(path.join(f.options.output, 'summary.md'), 'utf8')).toContain('BLOCKED: 1');
  });
  it('only verifies a matching complete passing required result', () => {
    const f = fixture(true); f.save();
    expect(collectCiEvidence(f.options)).toEqual({ verified: true, bundle: true, error: false });
  });
  it('produces only an incomplete summary when no completed report exists', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.run, 'results.partial.json'), 'private-partial-token');
    expect(collectCiEvidence(f.options)).toEqual({ verified: false, bundle: false, error: true });
    expect(fs.readdirSync(f.options.output)).toEqual(['summary.md']);
    expect(fs.readFileSync(path.join(f.options.output, 'summary.md'), 'utf8')).not.toContain('private-partial-token');
  });
  it('removes a bundle that fails source verification and masks malformed-result errors', () => {
    const f = fixture(true); f.save();
    expect(collectCiEvidence({ ...f.options, sha: 'd'.repeat(40) })).toEqual({ verified: false, bundle: false, error: true });
    fs.writeFileSync(path.join(f.run, 'results.json'), 'private-api-key-in-invalid-json');
    expect(collectCiEvidence(f.options).error).toBe(true);
    expect(fs.readdirSync(f.options.output)).toEqual(['summary.md']);
    expect(fs.readFileSync(path.join(f.options.output, 'summary.md'), 'utf8')).not.toContain('private-api-key');
  });
});
