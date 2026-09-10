import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { NANOCLAW_SHA, PACKAGE_ASSETS, validatePackage } from '../harness/lib/nanoclaw-package.mjs';
import { NanoClawRuntime } from '../harness/lib/nanoclaw.mjs';
import { prepareNanoClaw } from '../harness/scripts/prepare-nanoclaw.mjs';

const digest = 'sha256:' + 'a'.repeat(64);
const hash = text => createHash('sha256').update(text).digest('hex');
const assets = Object.fromEntries(PACKAGE_ASSETS.map(p => [p, hash(p)]));
const manifest = () => ({ schemaVersion: 1, sourceSha: NANOCLAW_SHA, imageId: digest, platform: 'linux/arm64', lockHash: assets['container/agent-runner/bun.lock'], assets });
const image = () => ({ Id: digest, Os: 'linux', Architecture: 'arm64', Config: { Labels: { 'dev.midbrain.harness.package': '1', 'dev.midbrain.harness.nanoclaw-sha': NANOCLAW_SHA, 'dev.nanoclaw.agent-runner-lock-sha256': assets['container/agent-runner/bun.lock'] } } });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('NanoClaw package identity', () => {
  it('accepts the exact packaged image and rejects stale source, substituted image, platform and lockfile', () => {
    expect(() => validatePackage(manifest(), image())).not.toThrow();
    for (const change of [{ sourceSha: 'b'.repeat(40) }, { imageId: 'sha256:' + 'b'.repeat(64) }, { platform: 'linux/amd64' }, { lockHash: 'b'.repeat(64) }]) {
      expect(() => validatePackage({ ...manifest(), ...change }, image())).toThrow();
    }
    const base = image(); delete base.Config.Labels['dev.midbrain.harness.package'];
    expect(() => validatePackage(manifest(), base)).toThrow();
  });
  it('rejects incomplete assets and mutable image references', () => {
    expect(() => validatePackage({ ...manifest(), assets: {} }, image())).toThrow();
    expect(() => validatePackage({ ...manifest(), imageId: 'nano:latest' }, image())).toThrow();
  });
});

describe('NanoClaw prepared runtime', () => {
  async function fixture(tamper = false) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'nano-package-'));
    const file = path.join(root, 'nanoclaw-image.json');
    writeFileSync(file, JSON.stringify(manifest()));
    vi.stubEnv('MIDBRAIN_HARNESS_NANOCLAW_MANIFEST', file);
    const runtime = new NanoClawRuntime({ dirs: { home: path.join(root, 'home'), run: root }, runId: 'test', secrets: {} }, { mode: 'registry' });
    runtime.prepareSourceImage = vi.fn(() => { throw Error('Must not clone/build'); });
    const calls = [];
    runtime.docker = async args => {
      calls.push(args);
      if (args[0] === 'image') return { code: 0, stdout: JSON.stringify([image()]) };
      if (args[0] === 'cp') {
        const asset = args[1].split('/opt/midbrain-harness/')[1];
        mkdirSync(path.dirname(args[2]), { recursive: true });
        writeFileSync(args[2], tamper ? 'changed' : asset);
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    return { root, runtime, calls };
  }
  it('loads assets without fetching source, runs baked source, and retains identity in evidence', async () => {
    const { root, runtime, calls } = await fixture();
    try {
      await runtime.prepare();
      expect(runtime.prepareSourceImage).not.toHaveBeenCalled();
      expect(runtime.runnerMountArgs()).toEqual([]);
      expect(calls.some(a => a[0] === 'run' || a[0] === 'build')).toBe(false);
      expect(calls.filter(a => a[0] === 'cp')).toHaveLength(PACKAGE_ASSETS.length);
      expect(calls.at(-1)[0]).toBe('rm');
      expect(runtime.containers.size).toBe(0);
      expect(JSON.parse(readFileSync(path.join(root, 'nanoclaw.json')))).toMatchObject({ packaged: true, sourceSha: NANOCLAW_SHA, image: digest, platform: 'linux/arm64' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects changed embedded assets and removes its temporary container on failure', async () => {
    const { root, runtime, calls } = await fixture(true);
    try {
      await expect(runtime.prepare()).rejects.toThrow(/asset/i);
      expect(calls.at(-1)[0]).toBe('rm');
      expect(runtime.containers.size).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

it('builds a minimal context and writes a manifest only after consuming the packaged assets', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nano-builder-'));
  const output = path.join(root, 'package');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(NanoClawRuntime.prototype, 'prepareSourceImage').mockImplementation(async function () {
    for (const file of [...PACKAGE_ASSETS, 'container/agent-runner/src/index.ts', '.env']) {
      const target = path.join(this.root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file);
    }
    return { base: image(), lockHash: manifest().lockHash };
  });
  const calls = [];
  vi.spyOn(NanoClawRuntime.prototype, 'docker').mockImplementation(async args => {
    calls.push(args);
    if (args[0] === 'build') {
      const stage = args.at(-1);
      expect(readdirSync(stage).sort()).toEqual(['Dockerfile', 'assets', 'runner']);
      expect(existsSync(path.join(stage, '.env'))).toBe(false);
      expect(readFileSync(path.join(stage, 'runner/index.ts'), 'utf8')).toBe('container/agent-runner/src/index.ts');
      expect(readFileSync(path.join(stage, 'assets/LICENSE'), 'utf8')).toBe('LICENSE');
    }
    if (args[0] === 'image') return { code: 0, stdout: JSON.stringify([image()]) };
    if (args[0] === 'cp') {
      expect(existsSync(path.join(output, 'nanoclaw-image.json'))).toBe(false);
      writeFileSync(args[2], args[1].split('/opt/midbrain-harness/')[1]);
    }
    return { code: 0, stdout: '', stderr: '' };
  });
  try {
    await prepareNanoClaw(output);
    expect(JSON.parse(readFileSync(path.join(output, 'nanoclaw-image.json')))).toMatchObject(manifest());
    expect(readFileSync(path.join(output, 'NANOCLAW-LICENSE'), 'utf8')).toBe('LICENSE');
    expect(calls.some(a => ['run', 'push', 'pull'].includes(a[0]))).toBe(false);
    await expect(prepareNanoClaw(output)).rejects.toThrow();
    expect(existsSync(path.join(output, 'nanoclaw-image.json'))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
