#!/usr/bin/env node
// Offline export only: never launch clients, change a run, or read the host's auth files.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { fileHash } from '../lib/candidate.mjs';
import { runExitCode } from '../lib/checks.mjs';
import { renderMarkdown } from '../lib/report.mjs';
import { ORDER, MANIFESTS } from '../clients/index.mjs';
import { SCENARIOS } from '../scenarios/index.mjs';
import { collectSecrets, loadDotEnv } from '../lib/env.mjs';

const pick = (object, keys) => Object.fromEntries(keys.filter(k => object?.[k] !== undefined).map(k => [k, object[k]]));
function json(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('Cannot read JSON input (contents withheld)'); }
}
const encode = value => JSON.stringify(value, null, 2) + '\n';
const secretKey = /(?:api[_-]?key|authorization|password|secret|(?:access|refresh|id|auth)[_-]?token|cookie|private[_-]?key)/i;

// Reject traversal and symlinks, including symlinked parents, before reading evidence.
function localFile(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || [...relative].some(c => c.charCodeAt(0) < 32) || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe bundle path');
  let file = root;
  for (const part of relative.split('/')) {
    file = path.join(file, part);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Symlinked evidence is not supported');
  }
  if (!fs.statSync(file).isFile() || fs.statSync(file).size > 16 * 1024 * 1024) throw new Error('Evidence must be a regular file under 16 MiB');
  return file;
}

// Recover rotated secrets from this run's credential files as well as current env.
// Those files are never added to the bundle. Do not traverse caches or raw evidence.
function runSecrets(root, supplied) {
  const values = new Set(supplied.filter(v => typeof v === 'string' && v.length >= 8));
  function leaves(value) {
    if (typeof value === 'string' && value.length >= 8) values.add(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(leaves);
  }
  function visit(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const file = path.join(dir, e.name);
      if (e.isDirectory() && !['node_modules', '.npm', 'candidate', 'registry', 'tools', 'evidence', 'logs', '.git'].includes(e.name)) visit(file);
      else if (e.isFile() && ['.midbrain-key', '.midbrain-keystore.json', 'auth.json', '.credentials.json', 'provider.env'].includes(e.name)) {
        if (fs.statSync(file).size > 1024 * 1024) throw new Error('Oversized credential file');
        const text = fs.readFileSync(file, 'utf8').trim();
        if (e.name.endsWith('.json')) leaves(json(file));
        else if (e.name.endsWith('.env')) text.split('\n').forEach(line => leaves(line.slice(line.indexOf('=') + 1)));
        else leaves(text);
      }
    }
  }
  visit(root);
  return [...values].sort((a, b) => b.length - a.length);
}

export function redactor(secrets, root) {
  function text(value) {
    for (const secret of secrets) value = value.split(secret).join('[REDACTED]');
    return value
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
      .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|npm_[\w]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[REDACTED]')
      .replace(/\b(Bearer|Basic)\s+[\w.+/=-]+/gi, '$1 [REDACTED]')
      .replace(/((?:[\w-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)|authorization)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]')
      .split(root).join('<run>')
      .split(root.replace(/^\/private(?=\/var\/|\/tmp\/)/, '')).join('<run>')
      .split(os.homedir()).join('<host-home>')
      .replace(/\/(?:Users|home)\/[^/\s"']+/g, '/<home>');
  }
  function scrub(value) {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [text(k), secretKey.test(k) ? '[REDACTED]' : scrub(v)]));
    return value;
  }
  return scrub;
}

export function gateProblems(results) {
  const problems = [];
  if (results.run?.simple) problems.push('Simple cycle is reduced coverage, not the full required matrix');
  if (!results.run?.finishedAt || !Number.isFinite(Date.parse(results.run.finishedAt))) problems.push('Run is incomplete');
  if (results.run?.required !== true || results.candidate?.mode !== 'registry' || results.candidate?.registry?.published !== true) problems.push('A full required registry/upgrade run is needed');
  if (results.candidate?.dirty !== false) problems.push('Candidate source was dirty or its status is unknown');
  if (runExitCode(results.cells || [], results.isolation?.ok === true && results.isolation?.drift?.length === 0)) problems.push('Not every cell passed with clean isolation');
  if ((results.cells || []).some(c => !c.checks?.length || c.checks.some(k => k.ok !== true))) problems.push('Missing or unsuccessful underlying checks');
  for (const id of ORDER) {
    if (!results.clients?.some(c => c.id === id && c.runnable && c.version)) problems.push(`Missing runnable client/version: ${id}`);
    if (!results.run?.models?.[id] || results.run.models[id] === 'client default') problems.push(`Missing model pin: ${id}`);
    for (const sc of SCENARIOS) {
      if (sc.id === 's10-client-specific') {
        for (const name of MANIFESTS[id].specific || []) if (!results.cells?.some(c => c.client === id && c.scenario === `${sc.id}/${name}`)) problems.push(`Missing coverage: ${id}/${sc.id}/${name}`);
        continue;
      }
      for (const row of sc.rows) {
        const count = (results.cells || []).filter(c => c.client === id && c.scenario === sc.id && c.row === row).length;
        if (count < (sc.kind === 'pair' ? ORDER.length - 1 : 1)) problems.push(`Missing coverage: ${id}/${sc.id}/${row}`);
      }
    }
    for (const row of ['Clean install', 'Tool availability', 'Reproducibility']) {
      if (!results.cells?.some(c => c.client === id && c.row === row)) problems.push(`Missing coverage: ${id}/${row}`);
    }
  }
  return problems;
}

function candidateSummary(c) {
  return {
    ...pick(c, ['name', 'version', 'sourceVersion', 'sha', 'shortSha', 'branch', 'dirty', 'mode', 'frozenAt', 'tarballSha256']),
    pack: pick(c.pack, ['filename', 'entryCount', 'integrity']),
    registry: pick(c.registry, ['publishVersion', 'published', 'exact', 'rewritten', 'originalSha256', 'publishedSha256']),
    harness: { files: c.harness?.files || {} },
  };
}

export function exportBundle(runDir, output, secrets = []) {
  const root = fs.realpathSync(runDir);
  const dest = path.resolve(output);
  const tail = [];
  let ancestor = dest;
  while (!fs.existsSync(ancestor)) { tail.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor); }
  const canonicalDest = path.join(fs.realpathSync(ancestor), ...tail);
  if (canonicalDest === root || canonicalDest.startsWith(root + path.sep)) throw new Error('Export must be outside the source run');
  if (fs.existsSync(dest)) throw new Error('Output already exists; choose a new bundle directory');
  const source = json(localFile(root, 'results.json'));
  if (!source.run?.finishedAt || !Number.isFinite(Date.parse(source.run.finishedAt))) throw new Error('Only completed results.json can be exported; partial/interruption reports are not release evidence');
  const candidate = source.candidate;
  const tarball = localFile(root, path.relative(root, fs.realpathSync(candidate.tarball)).split(path.sep).join('/'));
  if (fileHash(tarball) !== candidate.tarballSha256 || (candidate.registry && candidate.registry.publishedSha256 !== candidate.tarballSha256)) throw new Error('Tested candidate archive hash mismatch');
  if (!/^[a-f0-9]{40}$/.test(candidate.sha || '')) throw new Error('Missing full candidate source SHA');
  const scrub = redactor(runSecrets(root, secrets), root);
  const results = scrub({
    harnessVersion: source.harnessVersion,
    run: pick(source.run, ['required', 'simple', 'crossClientPairs', 'runId', 'marker', 'platform', 'arch', 'osRelease', 'node', 'startedAt', 'finishedAt', 'readbackTimeoutMs', 'indexGraceMs', 'models']),
    candidate: candidateSummary(candidate),
    clients: source.clients.map(c => pick(c, ['id', 'displayName', 'version', 'runnable', 'blockedReason', 'knownExceptions', 'mechanism', 'configShape'])),
    cells: source.cells.map(c => pick(c, ['row', 'scenario', 'client', 'clientDisplay', 'status', 'checks', 'prompt', 'expected', 'evidence', 'notes', 'blockedReason'])),
    isolation: source.isolation,
  });
  const files = new Map();
  const omitted = new Set();
  // Export only normalized turns, prompts, readbacks and the native approval receipt.
  // Raw streams, databases, configs, installer logs and whole transcripts stay private.
  function include(relative) {
    const file = localFile(root, relative);
    if (relative.endsWith('/approval-ui.txt')) files.set(relative, scrub(fs.readFileSync(file, 'utf8')));
    else if (relative.endsWith('.json')) {
      const value = json(file);
      if (value && ((relative.endsWith('.readback.json') && (Array.isArray(value) || Array.isArray(value.rows))) || (typeof value.prompt === 'string' && (typeof value.finalText === 'string' || relative.endsWith('.prompt.json'))))) files.set(relative, encode(scrub(value)));
      else omitted.add(relative);
    } else omitted.add(relative);
  }
  for (const cell of source.cells) {
    for (const relative of cell.evidence || []) {
      if (!/^evidence\/[a-z0-9_-]+\/[a-z0-9_-]+\/[^/]+$/.test(relative)) { omitted.add(relative); continue; }
      include(relative);
      const dir = path.posix.dirname(relative);
      // A raw-stream reference can have a normalized sibling; preserve that evidence.
      for (const name of fs.readdirSync(path.join(root, dir))) {
        if (name.endsWith('.json') || name === 'approval-ui.txt') include(`${dir}/${name}`);
      }
    }
  }
  for (const cell of results.cells) {
    const directories = new Set(source.cells.filter(c => c.scenario === cell.scenario && c.client === cell.client).flatMap(c => c.evidence || []).map(ref => path.posix.dirname(ref)));
    cell.evidence = [...files.keys()].filter(ref => directories.has(path.posix.dirname(ref)));
  }
  files.set('results.json', encode(results));
  files.set('candidate.json', encode(results.candidate));
  files.set('report.md', renderMarkdown(results));
  const problems = gateProblems(results);
  files.set('README.md', `# Release evidence: ${results.run.runId}\n\n${problems.length ? 'CHECKPOINT — not release sign-off.\n\n' + problems.map(p => '- ' + p).join('\n') : 'Required behavioral checks passed. Radu review and programmatic CI are still required.'}\n\nVerify against the intended release archive and full source SHA:\n\n\`node harness/scripts/release-evidence.mjs verify <bundle> <release.tgz> <source-sha>\`\n\nThe archive must match the tested SHA-256 exactly, including any RC version rewrite.\nNormalized evidence is redacted; raw streams, configs, databases and credential-bearing homes remain private. Omitted references are listed in manifest.json. Read this bundle before sharing; redaction is not a guarantee against arbitrary secrets embedded in model text. Checksums detect changes, not authorship: obtain the bundle through a trusted review/CI channel.\n`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(dest), '.release-evidence-'));
  try {
    const hashes = {};
    for (const [relative, text] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      const file = path.join(staging, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, { mode: 0o600 });
      hashes[relative] = fileHash(file);
    }
    fs.writeFileSync(path.join(staging, 'manifest.json'), encode({ schemaVersion: 1, files: hashes, omitted: scrub([...omitted].sort()) }), { mode: 0o600 });
    fs.renameSync(staging, dest);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  return { directory: dest, problems, fileCount: files.size + 1 };
}

export function verifyBundle(directory, tarball, sha) {
  const root = fs.realpathSync(directory);
  const manifest = json(localFile(root, 'manifest.json'));
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported bundle schema');
  for (const required of ['results.json', 'candidate.json', 'report.md', 'README.md']) if (!manifest.files?.[required]) throw new Error('Incomplete bundle manifest');
  for (const [relative, hash] of Object.entries(manifest.files)) if (fileHash(localFile(root, relative)) !== hash) throw new Error(`Bundle checksum mismatch: ${relative}`);
  function checkListed(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) checkListed(path.join(dir, entry.name), relative + '/');
      else {
        localFile(root, relative);
        if (relative !== 'manifest.json' && !manifest.files[relative]) throw new Error(`Unlisted bundle file: ${relative}`);
      }
    }
  }
  checkListed(root);
  const results = json(localFile(root, 'results.json'));
  if (encode(results.candidate) !== encode(json(localFile(root, 'candidate.json')))) throw new Error('Candidate identities disagree');
  if (renderMarkdown(results) !== fs.readFileSync(localFile(root, 'report.md'), 'utf8')) throw new Error('Report disagrees with results');
  if (!/^[a-f0-9]{40}$/.test(sha || '') || results.candidate.sha !== sha) throw new Error('Release source SHA does not match the tested candidate');
  if (fileHash(tarball) !== results.candidate.tarballSha256) throw new Error('Release archive does not match the tested candidate');
  for (const cell of results.cells) for (const ref of cell.evidence || []) if (!manifest.files[ref]) throw new Error('Evidence reference missing from manifest');
  return gateProblems(results);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, first, second, third] = process.argv.slice(2);
    if (command === 'export' && first && second && !third) {
      loadDotEnv(fileURLToPath(new URL('../.env', import.meta.url)));
      const result = exportBundle(first, second, Object.values(collectSecrets()));
      console.log(`${result.directory} (${result.fileCount} files; ${result.problems.length ? 'CHECKPOINT, not sign-off' : 'required behavioral checks passed'})`);
    } else if (command === 'verify' && first && second && third) {
      const problems = verifyBundle(first, second, third);
      console.log(problems.length ? 'NOT RELEASE-READY\n' + problems.join('\n') : 'PASS: required behavioral matrix, bundle checksums, source SHA and release archive match. Radu review and programmatic CI still required.');
      process.exitCode = problems.length ? 1 : 0;
    } else throw new Error('usage: release-evidence.mjs export <completed-run> <new-bundle-dir> | verify <bundle-dir> <release.tgz> <full-source-sha>');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
