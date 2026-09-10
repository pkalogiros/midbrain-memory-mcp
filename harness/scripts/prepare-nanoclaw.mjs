#!/usr/bin/env node
// Build locally; never publish. No provider credentials or behavioral sessions are needed.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRunContext, HARNESS_DIR } from '../lib/context.mjs';
import { NanoClawRuntime } from '../lib/nanoclaw.mjs';
import { NANOCLAW_SHA, PACKAGE_ASSETS, validatePackage } from '../lib/nanoclaw-package.mjs';

export async function prepareNanoClaw(output) {
  // Exclusive output directory prevents overwriting an earlier image manifest.
  mkdirSync(output, { recursive: false, mode: 0o700 });
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'midbrain-nano-package-'));
  const ctx = createRunContext({ root: scratch });
  const runtime = new NanoClawRuntime(ctx, { mode: 'registry' });
  const tag = 'midbrain-harness-nanoclaw-packaged:' + ctx.runId;
  try {
    await runtime.checkedDocker(['info']);
    console.error('Preparing pinned NanoClaw base image (first build may take several minutes)…');
    const { base, lockHash } = await runtime.prepareSourceImage();
    const stage = path.join(scratch, 'image');
    mkdirSync(stage);
    cpSync(path.join(runtime.root, 'container/agent-runner/src'), path.join(stage, 'runner'), { recursive: true });
    const assets = {};
    for (const file of PACKAGE_ASSETS) {
      const source = path.join(runtime.root, file);
      const target = path.join(stage, 'assets', file);
      mkdirSync(path.dirname(target), { recursive: true });
      cpSync(source, target);
      assets[file] = createHash('sha256').update(readFileSync(source)).digest('hex');
    }
    cpSync(path.join(HARNESS_DIR, 'container/Dockerfile'), path.join(stage, 'Dockerfile'));
    // A run-unique local tag makes FROM work without a registry lookup for a bare image ID.
    const baseRef = 'midbrain-harness-base:' + ctx.runId;
    await runtime.checkedDocker(['tag', base.Id, baseRef]);
    console.error('Packaging runner source, host assets and upstream license…');
    await runtime.checkedDocker(['build', '--build-arg', 'BASE_IMAGE=' + baseRef,
      '--label', 'dev.midbrain.harness.nanoclaw-sha=' + NANOCLAW_SHA,
      '-t', tag, stage], { timeoutMs: 1800000 });
    const image = JSON.parse((await runtime.checkedDocker(['image', 'inspect', tag])).stdout)[0];
    const manifest = { schemaVersion: 1, sourceSha: NANOCLAW_SHA, imageId: image.Id,
      platform: `${image.Os}/${image.Architecture}`, baseImageId: base.Id, lockHash, assets };
    validatePackage(manifest, image);
    // Verify the packaged assets through the same consumer path before publishing a manifest.
    const file = path.join(scratch, 'nanoclaw-image.json');
    writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    const verifier = new NanoClawRuntime(ctx, { mode: 'registry' });
    verifier.root = path.join(scratch, 'verify-assets');
    await verifier.preparePackagedImage(file);
    cpSync(file, path.join(output, 'nanoclaw-image.json'));
    cpSync(path.join(runtime.root, 'LICENSE'), path.join(output, 'NANOCLAW-LICENSE'));
    console.error('Prepared ' + manifest.platform + ' image ' + image.Id);
    return manifest;
  } catch (error) {
    const log = path.join(ctx.dirs.evidence, 'nanoclaw-build.log');
    if (existsSync(log)) console.error(readFileSync(log, 'utf8').slice(-4000));
    rmSync(output, { recursive: true, force: true });
    throw error;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith('-')) {
    console.error('Usage: node harness/scripts/prepare-nanoclaw.mjs /absolute/path/to/new-package-directory');
    process.exitCode = args[0] === '--help' ? 0 : 1;
  } else {
    try {
      const output = path.resolve(args[0]);
      await prepareNanoClaw(output);
      console.log(path.join(output, 'nanoclaw-image.json'));
    } catch (e) { console.error(e.message); process.exitCode = 1; }
  }
}
