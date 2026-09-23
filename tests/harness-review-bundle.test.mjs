import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exportReviewBundle, verifyReviewBundle } from '../harness/lib/review-bundle.mjs';
import { SCRIPTED_ROWS } from '../harness/lib/scripted-smoke-policy.mjs';

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-review-test-'));
  const source = path.join(root, 'run'); fs.mkdirSync(source);
  const evidence = 'evidence/pi/scripted-smoke/receipt.json';
  fs.mkdirSync(path.dirname(path.join(source, evidence)), { recursive: true });
  fs.writeFileSync(path.join(source, evidence), JSON.stringify({ schema: { properties: { api_key: { type: 'string' } } }, args: { api_key: 'mb-dry-smoke-project-fixture' }, text: 'Bearer sk-test-credential-123456789' }));
  const report = { run: { kind: 'scripted-smoke', runId: 'fixture<script>', complete: true, finishedAt: '2026-09-23T00:00:00Z', llmCalls: 0, platform: 'darwin', arch: 'arm64' }, candidate: {}, clients: [{ id: 'pi', displayName: 'Pi' }], isolation: { ok: true, drift: [] }, cells: SCRIPTED_ROWS.map(row => ({ row, client: 'pi', status: 'PASS', checks: [{ name: 'fixture check', ok: true }], evidence: [evidence] })) };
  fs.writeFileSync(path.join(source, 'results.json'), JSON.stringify(report));
  const dest = path.join(root, 'bundle');
  try { return fn({ root, source, dest, report, evidence, save: () => fs.writeFileSync(path.join(source, 'results.json'), JSON.stringify(report)) }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

describe('offline MCP review bundles', () => {
  it('redacts credential fields in native Hermes JSONL while preserving schemas', () => fixture(({ source, dest }) => {
    const file = 'evidence/hermes/scripted-smoke/native-session.jsonl';
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.writeFileSync(path.join(source, file), JSON.stringify({ api_key: 'opaque-secret-without-prefix', schema: { api_key: { type: 'string' } } }) + '\n');
    exportReviewBundle([source], dest);
    const record = JSON.parse(fs.readFileSync(path.join(dest, 'runs/01', file), 'utf8'));
    expect(record.api_key).toBe('[redacted credential]');
    expect(record.schema.api_key).toEqual({ type: 'string' });
    expect(verifyReviewBundle(dest).ok).toBe(true);
  }));
  it('exports a portable manifest and regenerated reports without homes or executable source HTML', () => fixture(({ source, dest }) => {
    fs.mkdirSync(path.join(source, 'home')); fs.writeFileSync(path.join(source, 'home', '.midbrain-key'), 'DO_NOT_COPY');
    fs.writeFileSync(path.join(source, 'report.html'), '<script>UNTRUSTED_SOURCE_HTML</script>');
    const before = fs.readFileSync(path.join(source, 'results.json'), 'utf8');
    exportReviewBundle([source], dest);
    expect(verifyReviewBundle(dest).ok).toBe(true);
    expect(fs.readFileSync(path.join(source, 'results.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(dest, 'runs/01/home'))).toBe(false);
    const html = fs.readFileSync(path.join(dest, 'index.html'), 'utf8');
    expect(html).toContain('fixture&lt;script&gt;'); expect(html).toContain('not release sign-off');
    expect(fs.readFileSync(path.join(dest, 'runs/01/report.html'), 'utf8')).not.toContain('UNTRUSTED_SOURCE_HTML');
    const receipt = JSON.parse(fs.readFileSync(path.join(dest, 'runs/01/evidence/pi/scripted-smoke/receipt.json')));
    expect(receipt.schema.properties.api_key).toEqual({ type: 'string' });
    expect(receipt.args.api_key).toBe('[redacted credential]');
    expect(JSON.stringify(receipt)).not.toContain('sk-test');
  }));
  it('detects changed, removed and unlisted files', () => fixture(({ source, dest }) => {
    exportReviewBundle([source], dest);
    fs.appendFileSync(path.join(dest, 'runs/01/report.md'), '\nchanged');
    expect(verifyReviewBundle(dest).ok).toBe(false);
    fs.writeFileSync(path.join(dest, 'extra.txt'), 'unexpected');
    expect(verifyReviewBundle(dest).problems.join(' ')).toMatch(/unlisted/i);
    fs.unlinkSync(path.join(dest, 'runs/01/results.json'));
    expect(verifyReviewBundle(dest).ok).toBe(false);
  }));
  it('rejects symlinked evidence and references escaping the run', () => fixture(({ root, source, dest, evidence, report, save }) => {
    fs.unlinkSync(path.join(source, evidence));
    const outside = path.join(root, 'outside.json'); fs.writeFileSync(outside, '{}');
    fs.symlinkSync(outside, path.join(source, evidence));
    expect(() => exportReviewBundle([source], dest)).toThrow(/symlink/i);
    expect(fs.existsSync(dest)).toBe(false);
    report.cells[0].evidence = ['../../outside.json']; save();
    expect(() => exportReviewBundle([source], dest)).toThrow(/unsafe|reference/i);
  }));
  it('refuses existing outputs, outputs inside a run and paid-mode reports', () => fixture(({ source, dest, report, save }) => {
    fs.mkdirSync(dest); fs.writeFileSync(path.join(dest, 'keep'), 'keep');
    expect(() => exportReviewBundle([source], dest)).toThrow(/exists/i);
    expect(fs.readFileSync(path.join(dest, 'keep'), 'utf8')).toBe('keep');
    expect(() => exportReviewBundle([source], path.join(source, 'bundle'))).toThrow(/outside/i);
    report.run.kind = 'live-smoke'; save();
    expect(() => exportReviewBundle([source], dest + '-new')).toThrow(/dry-smoke.*scripted-smoke/i);
  }));
  it('preserves failed and interrupted outcomes instead of presenting a green handoff', () => fixture(({ source, dest, report, save }) => {
    report.run.complete = false; report.run.error = 'Interrupted'; save();
    exportReviewBundle([source], dest);
    const result = verifyReviewBundle(dest);
    expect(result.ok).toBe(true); expect(result.runs[0].outcome).toBe('INCOMPLETE');
    expect(fs.readFileSync(path.join(dest, 'index.html'), 'utf8')).toContain('INCOMPLETE');
  }));
  it('rejects missing linked evidence and malicious manifest paths', () => fixture(({ source, dest, evidence }) => {
    fs.unlinkSync(path.join(source, evidence));
    expect(() => exportReviewBundle([source], dest)).toThrow(/missing.*evidence/i);
    fs.writeFileSync(path.join(source, evidence), '{}'); exportReviewBundle([source], dest);
    const file = path.join(dest, 'manifest.json'); const manifest = JSON.parse(fs.readFileSync(file));
    manifest.files['../outside'] = { sha256: '0'.repeat(64), bytes: 0 };
    fs.writeFileSync(file, JSON.stringify(manifest));
    expect(verifyReviewBundle(dest).ok).toBe(false);
  }));
  it('exports blocked preflight without a broken receipt link', () => fixture(({ source, dest, report, evidence, save }) => {
    fs.unlinkSync(path.join(source, evidence));
    report.cells.forEach(c => { c.status = 'BLOCKED'; c.checks = []; c.evidence = []; c.blockedReason = 'Client missing'; }); save();
    exportReviewBundle([source], dest);
    expect(fs.readFileSync(path.join(dest, 'runs/01/report.html'), 'utf8')).not.toContain('href="evidence/pi/scripted-smoke/receipt.json"');
    expect(verifyReviewBundle(dest).runs[0].outcome).toBe('BLOCKED');
  }));
  it('detects a manifest summary that misstates the host or assertion count', () => fixture(({ source, dest }) => {
    exportReviewBundle([source], dest);
    const file = path.join(dest, 'manifest.json'); const manifest = JSON.parse(fs.readFileSync(file));
    manifest.runs[0].host = 'linux/x64'; manifest.runs[0].passed = 999;
    fs.writeFileSync(file, JSON.stringify(manifest));
    expect(verifyReviewBundle(dest).ok).toBe(false);
  }));
});
