// A run owns one packed candidate. Clients never execute the moving checkout.
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, HARNESS_DIR } from './context.mjs';

export function fileHash(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function command(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed: ${(r.stderr || r.error?.message || '').slice(-1000)}`);
  return r.stdout.trim();
}
function git(args) {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function snapshotFiles(root, { include = () => true } = {}) {
  const files = {};
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && include(file)) files[path.relative(root, file)] = fileHash(file);
    }
  }
  visit(root);
  return files;
}
export function assertFilesUnchanged(root, expected) {
  for (const [rel, hash] of Object.entries(expected)) {
    if (fileHash(path.join(root, rel)) !== hash) throw new Error(`Frozen input changed: ${rel}`);
  }
}
export function assertCandidate(candidate) {
  if (!candidate?.files) return;
  assertFilesUnchanged(candidate.repoRoot, candidate.files);
  assertFilesUnchanged(HARNESS_DIR, candidate.harness.files);
  if (fileHash(candidate.tarball) !== candidate.tarballSha256) throw new Error('Frozen candidate tarball changed');
  if (candidate.registry && fileHash(candidate.registry.tarball) !== candidate.registry.publishedSha256) throw new Error('Registry candidate tarball changed');
}

export async function freezeCandidate({ mode = 'dev', directory } = {}) {
  if (!['dev', 'registry'].includes(mode)) throw new Error(`unknown candidate mode "${mode}" (dev | registry)`);
  const dir = directory || mkdtempSync(path.join(os.tmpdir(), 'midbrain-candidate-'));
  mkdirSync(dir, { recursive: true });
  command('npm', ['run', 'build:plugin'], REPO_ROOT);
  const pack = JSON.parse(command('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', dir], REPO_ROOT))[0];
  const tarball = path.join(dir, pack.filename);
  command('tar', ['-xzf', tarball, '-C', dir], REPO_ROOT);
  const repoRoot = path.join(dir, 'package');
  // npm excludes lockfiles from published packages; preserve the source lock
  // separately and use it for the isolated dev runtime's exact dependencies.
  cpSync(path.join(REPO_ROOT, 'package-lock.json'), path.join(repoRoot, 'package-lock.json'));
  command('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], repoRoot);
  const harnessDir = path.join(dir, 'harness');
  const harnessFiles = snapshotFiles(HARNESS_DIR, { include: file => /\.(mjs|json|ts|py)$/.test(file) || path.basename(file) === 'Dockerfile' });
  for (const rel of Object.keys(harnessFiles)) {
    const target = path.join(harnessDir, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(HARNESS_DIR, rel), target);
  }
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const sha = git(['rev-parse', 'HEAD']);
  const candidate = {
    mode, name: pkg.name, version: pkg.version, sha, shortSha: sha?.slice(0, 7),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']), dirty: Boolean(git(['status', '--porcelain'])),
    repoRoot, tarball, tarballSha256: fileHash(tarball), files: snapshotFiles(repoRoot),
    pack: { ...pack, files: pack.files.map(f => f.path) },
    harness: { directory: harnessDir, files: harnessFiles }, frozenAt: new Date().toISOString(),
  };
  // Registry mode may rewrite the runtime package version to an rc; preserve
  // the packed source identity independently for follow-up compatibility.
  candidate.sourceFiles = { ...candidate.files };
  candidate.sourceTarballSha256 = candidate.tarballSha256;
  writeFileSync(path.join(dir, 'identity.json'), JSON.stringify(candidate, null, 2) + '\n');
  return candidate;
}
