import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportBundle, verifyBundle } from '../harness/scripts/release-evidence.mjs';
import { fileHash } from '../harness/lib/candidate.mjs';
import { ORDER, MANIFESTS } from '../harness/clients/index.mjs';
import { SCENARIOS } from '../harness/scenarios/index.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-evidence-'));
  roots.push(root);
  const run = path.join(root, 'run');
  const bundle = path.join(root, 'bundle');
  const archive = path.join(run, 'candidate', 'tested-rc.tgz');
  write(archive, 'the exact tested RC archive');
  const sha = 'a'.repeat(40);
  const cells = [];
  const add = (client, scenario, row) => cells.push({ client, scenario, row, status: 'PASS', checks: [{ name: 'observed', ok: true }], evidence: [] });
  for (const client of ORDER) {
    for (const sc of SCENARIOS) {
      if (sc.id === 's10-client-specific') {
        for (const name of MANIFESTS[client].specific) add(client, `${sc.id}/${name}`, 'Client-specific scenarios');
      } else for (const row of sc.rows) for (let n = 0; n < (sc.kind === 'pair' ? ORDER.length - 1 : 1); n++) add(client, sc.id, row);
    }
    for (const row of ['Clean install', 'Tool availability', 'Reproducibility']) add(client, 'derived', row);
  }
  const evidence = 'evidence/claude/s01-capture/turn-1.json';
  cells.find(c => c.client === 'claude').evidence = [evidence, evidence.replace('.json', '.ndjson')];
  const value = {
    harnessVersion: 'test',
    run: { required: true, runId: 'example', startedAt: '2026-09-08T00:00:00Z', finishedAt: '2026-09-08T01:00:00Z', models: Object.fromEntries(ORDER.map(c => [c, 'pinned-model'])) },
    candidate: { name: 'midbrain-memory-mcp', version: '1.0.1-rc.a', sha, shortSha: sha.slice(0, 7), dirty: false, mode: 'registry', tarball: archive, tarballSha256: fileHash(archive), registry: { published: true, publishedSha256: fileHash(archive) } },
    clients: ORDER.map(id => ({ id, displayName: id, version: '1.0', runnable: true })),
    cells, isolation: { ok: true, drift: [] },
  };
  write(path.join(run, evidence), { prompt: 'remember MBH-TEST', finalText: 'MBH-TEST', toolCalls: [] });
  write(path.join(run, evidence.replace('.json', '.ndjson')), 'private raw stream');
  write(path.join(run, 'results.json'), value);
  return { root, run, bundle, archive, sha, value, evidence, save() { write(path.join(run, 'results.json'), value); } };
}

describe('release evidence bundle', () => {
  it('exports a portable review bundle without copying raw streams or the run home', () => {
    const f = fixture();
    write(path.join(f.run, 'home/.codex/auth.json'), { tokens: { access_token: 'old-rotated-secret-value' } });
    write(path.join(f.run, 'home/.config/midbrain/.midbrain-key'), 'retired-memory-key-value');
    write(path.join(f.run, f.evidence), {
      prompt: 'remember MBH-TEST', finalText: 'MBH-TEST old-rotated-secret-value retired-memory-key-value current-provider-secret',
      toolCalls: [{ input: { api_key: 'unknown-secret-value' }, result: 'Bearer token-that-was-not-in-env' }],
      rawPath: path.join(f.run, 'home/private.json'),
    });
    write(path.join(f.run, f.evidence.replace('.json', '.readback.json')), [{ text: 'MBH-TEST', role: 'assistant' }]);
    const exported = exportBundle(f.run, f.bundle, ['current-provider-secret']);
    expect(exported.problems).toEqual([]);
    expect(verifyBundle(f.bundle, f.archive, f.sha)).toEqual([]);
    const text = fs.readFileSync(path.join(f.bundle, f.evidence), 'utf8');
    for (const secret of ['old-rotated-secret-value', 'retired-memory-key-value', 'current-provider-secret', 'unknown-secret-value', 'token-that-was-not-in-env', f.run]) expect(text).not.toContain(secret);
    expect(text).toContain('MBH-TEST');
    expect(fs.readFileSync(path.join(f.bundle, f.evidence.replace('.json', '.readback.json')), 'utf8')).toContain('MBH-TEST');
    expect(fs.existsSync(path.join(f.bundle, 'home'))).toBe(false);
    expect(fs.existsSync(path.join(f.bundle, f.evidence.replace('.json', '.ndjson')))).toBe(false);
    expect(fs.readFileSync(path.join(f.bundle, 'manifest.json'), 'utf8')).toContain('turn-1.ndjson');
    expect(() => exportBundle(f.run, f.bundle)).toThrow('already exists');
  });

  it('requires the intended full source SHA and the exact RC archive', () => {
    const f = fixture();
    exportBundle(f.run, f.bundle);
    expect(() => verifyBundle(f.bundle, f.archive, 'b'.repeat(40))).toThrow('source SHA');
    const other = path.join(f.root, 'repacked-stable.tgz');
    write(other, 'same source but different version or archive bytes');
    expect(() => verifyBundle(f.bundle, other, f.sha)).toThrow('archive');
    write(f.archive, 'tampered original');
    expect(() => exportBundle(f.run, path.join(f.root, 'another'))).toThrow('archive hash mismatch');
  });

  it('rejects modified bundle contents and unlisted files', () => {
    const f = fixture();
    exportBundle(f.run, f.bundle);
    write(path.join(f.bundle, 'accidental-auth.json'), { api_key: 'do-not-share' });
    expect(() => verifyBundle(f.bundle, f.archive, f.sha)).toThrow('Unlisted');
    fs.unlinkSync(path.join(f.bundle, 'accidental-auth.json'));
    fs.appendFileSync(path.join(f.bundle, 'report.md'), 'changed');
    expect(() => verifyBundle(f.bundle, f.archive, f.sha)).toThrow('checksum');
  });

  it.each(['focused', 'failed', 'blocked', 'missing-pair', 'missing-approval', 'missing-check', 'dirty', 'drift', 'no-model'])('exports %s evidence honestly but refuses release verification', reason => {
    const f = fixture();
    if (reason === 'focused') f.value.run.required = false;
    if (reason === 'failed') f.value.cells[0].status = 'FAIL';
    if (reason === 'blocked') f.value.cells[0].status = 'BLOCKED';
    if (reason === 'missing-pair') f.value.cells.splice(f.value.cells.findIndex(c => c.scenario.startsWith('s02')), 1);
    if (reason === 'missing-approval') f.value.cells.splice(f.value.cells.findIndex(c => c.scenario.endsWith('/hook-trust-persisted')), 1);
    if (reason === 'missing-check') f.value.cells[0].checks = [];
    if (reason === 'dirty') f.value.candidate.dirty = true;
    if (reason === 'drift') f.value.isolation.drift = [{ surface: 'home', before: 'a', after: 'b' }];
    if (reason === 'no-model') delete f.value.run.models.claude;
    f.save();
    expect(exportBundle(f.run, f.bundle).problems.length).toBeGreaterThan(0);
    expect(verifyBundle(f.bundle, f.archive, f.sha).length).toBeGreaterThan(0);
    expect(fs.readFileSync(path.join(f.bundle, 'README.md'), 'utf8')).toContain('CHECKPOINT');
  });

  it('refuses incomplete runs, symlinked evidence, and exporting into the source run', () => {
    const f = fixture();
    delete f.value.run.finishedAt;
    f.save();
    expect(() => exportBundle(f.run, f.bundle)).toThrow('completed');
    f.value.run.finishedAt = '2026-09-08T01:00:00Z';
    f.save();
    expect(() => exportBundle(f.run, path.join(f.run, 'bundle'))).toThrow('outside');
    expect(() => exportBundle(f.run, path.join(f.run, 'new-parent/bundle'))).toThrow('outside');
    expect(fs.existsSync(path.join(f.run, 'new-parent'))).toBe(false);
    const file = path.join(f.run, f.evidence);
    fs.unlinkSync(file);
    write(path.join(f.root, 'secret.json'), { prompt: 'secret', finalText: 'secret' });
    fs.symlinkSync(path.join(f.root, 'secret.json'), file);
    expect(() => exportBundle(f.run, f.bundle)).toThrow('Symlinked');
  });

  it('does not expose credential contents in JSON parse errors', () => {
    const f = fixture();
    write(path.join(f.run, 'home/.codex/auth.json'), 'secret-that-must-not-appear-in-an-error');
    expect(() => exportBundle(f.run, f.bundle)).toThrow('contents withheld');
  });
});
