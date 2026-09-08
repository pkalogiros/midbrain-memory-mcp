// Loopback npm registry (Verdaccio) that serves the exact candidate tarball as
// `latest` while proxying everything else to npmjs. This makes the product's
// normal `npx -y midbrain-memory-mcp@latest` path resolve the candidate and
// enables the upgrade-continuity scenario.
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { childEnv } from './context.mjs';
import { spawnCapture } from './proc.mjs';
import { sleep } from './api.mjs';

export const VERDACCIO_SPEC = process.env.MIDBRAIN_HARNESS_VERDACCIO || 'verdaccio@6';

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function registryConfig(dir) {
  return [
    `storage: ${JSON.stringify(path.join(dir, 'storage'))}`,
    'uplinks:',
    '  npmjs:',
    '    url: https://registry.npmjs.org/',
    '    maxage: 2m',
    'packages:',
    "  '**':",
    '    access: $all',
    '    publish: $all',
    '    unpublish: $all',
    '    proxy: npmjs',
    'auth:',
    '  htpasswd:',
    `    file: ${JSON.stringify(path.join(dir, 'htpasswd'))}`,
    '    max_users: 1',
    'security:',
    '  api:',
    '    legacy: true',
    'log:',
    '  type: file',
    `  path: ${JSON.stringify(path.join(dir, 'verdaccio.log'))}`,
    '  level: info',
    '',
  ].join('\n');
}

export async function startRegistry(ctx) {
  const dir = path.join(ctx.dirs.run, 'registry');
  mkdirSync(path.join(dir, 'storage'), { recursive: true });
  const configPath = path.join(dir, 'config.yaml');
  writeFileSync(configPath, registryConfig(dir));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  // Verdaccio itself is a host tool; it runs with the host env (its own npx cache).
  const child = spawn('npx', ['-y', VERDACCIO_SPEC, '--config', configPath, '--listen', `127.0.0.1:${port}`], {
    cwd: dir,
    env: { ...process.env, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', (c) => { output += c.toString('utf8'); });
  child.stderr.on('data', (c) => { output += c.toString('utf8'); });
  const deadline = Date.now() + 180000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${url}-/ping`);
      if (res.ok) { ready = true; break; }
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  if (!ready) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    throw new Error(`loopback registry did not become ready: ${output.trim().slice(-600)}`);
  }
  const registry = {
    url, port, dir, configPath, child,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const t = Date.now() + 10000;
      while (child.exitCode === null && Date.now() < t) await sleep(200);
      if (child.exitCode === null) { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
    },
  };
  process.on('exit', () => { try { if (child.exitCode === null) child.kill('SIGKILL'); } catch { /* ignore */ } });
  return registry;
}

/** Point the throwaway home's npm at the loopback (npx inside the clients inherits HOME). */
export function writeNpmrc(ctx, registry) {
  const file = path.join(ctx.dirs.home, '.npmrc');
  writeFileSync(file, [
    `registry=${registry.url}`,
    `//127.0.0.1:${registry.port}/:_authToken=midbrain-harness-anonymous`,
    'fund=false',
    'audit=false',
    'update-notifier=false',
    '',
  ].join('\n'));
  return file;
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * Produce the tarball to publish. When `version` differs from the checkout's
 * package.json the original tarball is extracted, only package.json#version is
 * rewritten, and it is re-packed, so the working tree is never touched.
 */
export function packForRegistry(ctx, candidate, { version }) {
  const dir = path.join(ctx.dirs.run, 'registry', 'pack');
  mkdirSync(dir, { recursive: true });
  const original = candidate.tarball;
  const originalSha = sha256File(original);
  if (version === candidate.version) {
    return { tarball: original, originalTarball: original, originalSha256: originalSha, publishedSha256: originalSha, version, rewritten: false };
  }
  const extractDir = path.join(dir, 'extract');
  rmSync(extractDir, { recursive: true, force: true });
  mkdirSync(extractDir, { recursive: true });
  const tar = spawnSync('tar', ['-xzf', original, '-C', extractDir], { encoding: 'utf8' });
  if (tar.status !== 0) throw new Error(`tar extract failed: ${tar.stderr.slice(-300)}`);
  const pkgDir = path.join(extractDir, 'package');
  const pkgPath = path.join(pkgDir, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const repackDir = path.join(dir, 'repack');
  rmSync(repackDir, { recursive: true, force: true });
  mkdirSync(repackDir, { recursive: true });
  const repacked = spawnSync('npm', ['pack', '--pack-destination', repackDir, '--ignore-scripts', '--json'], { cwd: pkgDir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (repacked.status !== 0) throw new Error(`npm re-pack failed: ${repacked.stderr.slice(-500)}`);
  const rinfo = JSON.parse(repacked.stdout);
  const tarball = path.join(repackDir, (Array.isArray(rinfo) ? rinfo[0] : rinfo).filename);
  return { tarball, originalTarball: original, originalSha256: originalSha, publishedSha256: sha256File(tarball), version, rewritten: true };
}

export async function publishTarball(ctx, registry, tarball, { tag = 'latest' } = {}) {
  const r = await spawnCapture('npm', ['publish', tarball, '--registry', registry.url, '--tag', tag, '--ignore-scripts'], {
    cwd: ctx.dirs.run,
    env: childEnv(ctx),
    timeoutMs: 120000,
  });
  if (r.code !== 0) throw new Error(`npm publish to loopback failed (exit ${r.code}): ${r.stderr.trim().slice(-800)}`);
  return r;
}

export async function registryLatest(registry, name) {
  const res = await fetch(`${registry.url}${name}/latest`);
  if (!res.ok) return null;
  const json = await res.json();
  return json.version || null;
}

export async function upstreamHasVersion(name, version) {
  const r = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--json'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim().length > 0;
}

/** Version to publish: exact when unpublished upstream, else next patch with an rc suffix (never a fake stable). */
export async function choosePublishVersion(candidate) {
  const exists = await upstreamHasVersion(candidate.name, candidate.version);
  if (!exists) return { version: candidate.version, exact: true };
  const [maj, min, pat] = candidate.version.split('.').map((s) => parseInt(s, 10));
  return { version: `${maj}.${min}.${pat + 1}-rc.${candidate.shortSha}`, exact: false };
}

/** Throwaway-home npx resolution of the package, as the clients will do it. */
export async function npxVersion(ctx, name) {
  const r = await spawnCapture('npx', ['-y', `${name}@latest`, '--version'], { cwd: ctx.dirs.run, env: childEnv(ctx), timeoutMs: 180000 });
  return { version: r.stdout.trim().split('\n').pop() || null, code: r.code, stderr: r.stderr.slice(-300) };
}

export function clearNpxCache(ctx) {
  const dir = path.join(ctx.dirs.home, '.npm', '_npx');
  const existed = existsSync(dir);
  rmSync(dir, { recursive: true, force: true });
  return existed;
}

export function copyForRepack(src, dest) {
  cpSync(src, dest, { recursive: true });
}

/** Start the loopback, point the throwaway home at it, pack the candidate; publish unless deferred. */
export async function prepareRegistry(ctx, candidate, { publish = true } = {}) {
  const registry = await startRegistry(ctx);
  ctx.registry = registry;
  writeNpmrc(ctx, registry);
  const { version, exact } = await choosePublishVersion(candidate);
  const packed = packForRegistry(ctx, candidate, { version });
  candidate.registry = { url: registry.url, publishVersion: version, exact, published: false, ...packed };
  // Inspection must load the same package version the clients will execute.
  candidate.sourceVersion = candidate.version;
  candidate.version = version;
  candidate.tarball = packed.tarball;
  candidate.tarballSha256 = packed.publishedSha256;
  const packageFile = path.join(candidate.repoRoot, 'package.json');
  const pkg = JSON.parse(readFileSync(packageFile, 'utf8'));
  pkg.version = version;
  writeFileSync(packageFile, JSON.stringify(pkg, null, 2) + '\n');
  candidate.files['package.json'] = sha256File(packageFile);
  ctx.writeJson(path.join(ctx.dirs.run, 'candidate/identity.json'), candidate);
  if (publish) await publishCandidate(ctx, candidate);
  return registry;
}

export async function publishCandidate(ctx, candidate) {
  await publishTarball(ctx, ctx.registry, candidate.registry.tarball);
  let latest = await registryLatest(ctx.registry, candidate.name);
  if (latest !== candidate.registry.publishVersion) {
    // Local dist-tag must win over the proxied upstream tag.
    await spawnCapture('npm', ['dist-tag', 'add', `${candidate.name}@${candidate.registry.publishVersion}`, 'latest', '--registry', ctx.registry.url], { cwd: ctx.dirs.run, env: childEnv(ctx), timeoutMs: 60000 });
    latest = await registryLatest(ctx.registry, candidate.name);
  }
  candidate.registry.published = true;
  candidate.registry.latestAfterPublish = latest;
  return latest;
}
