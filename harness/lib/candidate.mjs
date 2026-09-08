// Freeze the release candidate identity. Dev mode points clients at this
// checkout through the installer's own --dev switch; registry mode (loopback
// npm registry serving the exact tarball) is phase 2, see the design doc §7.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT } from './context.mjs';

function git(args) {
  const r = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

export async function freezeCandidate({ mode = 'dev' } = {}) {
  if (mode !== 'dev' && mode !== 'registry') {
    throw new Error(`unknown candidate mode "${mode}" (dev | registry)`);
  }
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const sha = git(['rev-parse', 'HEAD']);
  const dirty = (git(['status', '--porcelain', '--untracked-files=no']) || '') !== '';
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);

  const bundle = path.join(REPO_ROOT, 'dist', 'midbrain-shared.mjs');
  if (!existsSync(bundle)) {
    const b = spawnSync('npm', ['run', 'build:plugin'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (b.status !== 0) throw new Error(`build:plugin failed:\n${b.stderr}`);
  }

  const pack = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  let packInfo;
  if (pack.status === 0) {
    try {
      const parsed = JSON.parse(pack.stdout);
      const p = Array.isArray(parsed) ? parsed[0] : parsed;
      packInfo = {
        filename: p.filename,
        integrity: p.integrity,
        shasum: p.shasum,
        size: p.size,
        unpackedSize: p.unpackedSize,
        entryCount: p.entryCount,
        files: (p.files || []).map((f) => f.path),
      };
    } catch (e) {
      packInfo = { error: `pack json parse failed: ${e.message}` };
    }
  } else {
    packInfo = { error: pack.stderr.trim().slice(0, 500) };
  }

  return {
    mode,
    name: pkg.name,
    version: pkg.version,
    sha,
    shortSha: sha ? sha.slice(0, 7) : null,
    branch,
    dirty,
    repoRoot: REPO_ROOT,
    pack: packInfo,
    frozenAt: new Date().toISOString(),
  };
}
