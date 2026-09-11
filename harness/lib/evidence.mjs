// Evidence collectors: file trees, log tails, cache/spool counts, config shape.
import { existsSync, readdirSync, lstatSync, statSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function walk(dir, pred, out = []) {
  if (!existsSync(dir) || lstatSync(dir).isSymbolicLink()) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, pred, out);
    else if (ent.isFile() && (!pred || pred(p))) out.push(p);
  }
  return out;
}

export function copyTree(srcDir, destDir, pred) {
  const files = walk(srcDir, pred);
  for (const f of files) {
    const d = path.join(destDir, path.relative(srcDir, f));
    mkdirSync(path.dirname(d), { recursive: true });
    copyFileSync(f, d);
  }
  return files.length;
}

export function countLines(file) {
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
}

export function cacheSpoolCounts(ctx) {
  const home = ctx.dirs.home;
  const cacheDir = path.join(home, '.cache', 'midbrain');
  const cache = walk(cacheDir, (p) => p.endsWith('.ndjson')).reduce((n, f) => n + countLines(f), 0);
  const spool = countLines(path.join(home, '.claude', '.midbrain-spool.ndjson'));
  return { cache, spool };
}

export function midbrainLogPath(ctx, clientId) {
  return path.join(ctx.dirs.logs, `midbrain-${clientId}.log`);
}

export function readLogTail(file, maxChars = 20000) {
  if (!existsSync(file)) return '';
  const t = readFileSync(file, 'utf8');
  return t.length > maxChars ? t.slice(-maxChars) : t;
}

export function grepLog(file, re) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => re.test(l));
}

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Hash the product-owned config surfaces a manifest declares (report evidence, never contents). */
export function configShapeSnapshot(ctx, manifest) {
  const out = {};
  for (const spec of manifest.configShape || []) {
    const [rel] = spec.split('#');
    const abs = rel.startsWith('~/') ? path.join(ctx.dirs.home, rel.slice(2)) : path.resolve(ctx.dirs.home, rel);
    if (!existsSync(abs)) { out[spec] = 'ABSENT'; continue; }
    out[spec] = statSync(abs).isDirectory() ? 'DIR' : `sha256:${sha256File(abs).slice(0, 16)}`;
  }
  return out;
}
