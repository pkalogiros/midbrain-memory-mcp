// Offline review export for synthetic smoke modes. Never reads credentials,
// launches clients or changes the source runs. This is not the release gate.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { renderRunHtml } from './report-html.mjs';
import { renderMarkdown } from './report.mjs';
import { renderDrySmokeJUnit } from './dry-smoke-report.mjs';
import { renderScriptedJUnit } from './scripted-smoke-report.mjs';
import { drySmokeOutcome } from './dry-smoke-policy.mjs';
import { scriptedOutcome } from './scripted-smoke-policy.mjs';
import { SMOKE_KEYS } from './dry-smoke-fixture.mjs';

const MAX_FILE = 16 * 1024 * 1024;
const MAX_TOTAL = 200 * 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const encode = value => JSON.stringify(value, null, 2) + '\n';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const evidencePattern = /^evidence\/(?:_install\/[a-z0-9_-]+\.(?:stdout|stderr)\.txt|fixture-requests\.json|(?:pi|opencode|claude|codex|hermes)\/(?:dry-smoke|scripted-smoke)\/(?:mcp-probe\.json|native-probe\.json|mcp-context-preview\.(?:json|md)|mcp-events\.ndjson|protocol-events\.ndjson|receipt\.json|provider-events\.ndjson|native\.ndjson|native-session\.jsonl|peer-events\.ndjson|mcp-events\/[0-9]+\.ndjson))$/;
function safeRelative(relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\') || /[:?#]/.test(relative) || [...relative].some(c => c.charCodeAt(0) < 32) || relative.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Unsafe bundle path or evidence reference');
  return relative;
}
function localFile(root, relative) {
  safeRelative(relative);
  let file = root;
  for (const component of relative.split('/')) {
    file = path.join(file, component);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Symlinked evidence is not supported');
  }
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Evidence must be a regular file under 16 MiB');
  return file;
}
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, typeof v === 'string' && /^(?:api[_-]?key|user_api_key|authorization|password|secret|(?:access|refresh|auth)[_-]?token)$/i.test(key) ? '[redacted credential]' : scrub(v)]));
  if (typeof value !== 'string') return value;
  for (const key of Object.values(SMOKE_KEYS)) value = value.split(key).join('[redacted credential]');
  return value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted credential]')
    .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]+|github_pat_[\w]+|npm_[\w]+)\b/g, '[redacted credential]')
    .replace(/\b(Bearer|Basic)\s+[\w.+/=-]+/gi, '$1 [redacted credential]');
}
function redactFile(relative, bytes) {
  const text = bytes.toString('utf8');
  if (relative.endsWith('.json')) return encode(scrub(JSON.parse(text)));
  if (/\.(?:ndjson|jsonl)$/.test(relative)) return text.split('\n').map(line => {
    if (!line.trim()) return line;
    try { return JSON.stringify(scrub(JSON.parse(line))); } catch { return scrub(line); }
  }).join('\n');
  return scrub(text);
}
function outcome(report) {
  if (!['dry-smoke', 'scripted-smoke'].includes(report.run?.kind)) throw new Error('Review bundles support dry-smoke and scripted-smoke only; paid-mode evidence is excluded');
  if (!Array.isArray(report.cells) || !Array.isArray(report.clients) || !report.isolation) throw new Error('Missing smoke report structure');
  return report.run.kind === 'dry-smoke' ? drySmokeOutcome(report.cells, report.isolation.ok, report.run.complete, report.clients.map(c => c.id)) : scriptedOutcome(report);
}
function references(report) {
  const refs = report.cells.flatMap(c => c.evidence || []);
  for (const preview of Object.values(report.contextPreviews || {})) refs.push(...Object.values(preview.artifacts || {}));
  for (const ref of refs) { safeRelative(ref); if (!evidencePattern.test(ref)) throw new Error('Unsupported evidence reference; refusing to export private files'); }
  return [...new Set(refs)];
}
function inventory(root, selectedOnly = false) {
  const files = [];
  function walk(relative, depth) {
    if (depth > 8 || files.length > 2000) throw new Error('Bundle inventory exceeds limits');
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (selectedOnly && entry.isDirectory() && !/^evidence(?:\/(?:pi|opencode|claude|codex|hermes|_install))?(?:\/(?:dry-smoke|scripted-smoke))?(?:\/mcp-events)?$/.test(name)) continue;
      if (entry.isSymbolicLink()) {
        if (!selectedOnly || evidencePattern.test(name) || /^evidence(?:\/|$)/.test(name)) throw new Error('Symlinked evidence is not supported');
        continue;
      }
      if (entry.isDirectory()) walk(name, depth + 1);
      else if (!selectedOnly || evidencePattern.test(name)) { localFile(root, name); files.push(name); }
    }
  }
  walk('', 0); return files.sort();
}
function overview(runs) {
  const rows = runs.map(r => `<tr><td><a href="${r.directory}/report.html">${esc(r.kind)} · ${esc(r.clients.join(', '))}</a><br><small>${esc(r.runId)}</small></td><td class="${r.outcome === 'PASS' ? 'pass' : 'attention'}">${esc(r.outcome)}</td><td>${r.passed} / ${r.assertions}</td><td>${esc(r.host)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MidBrain MCP review evidence</title><style>body{margin:0;background:#f4f5ef;color:#193d35;font:16px/1.6 system-ui,sans-serif}main{max-width:1080px;margin:auto;padding:42px 24px}h1{font:600 clamp(34px,5vw,54px)/1.15 Georgia,serif}h2{font:600 26px Georgia,serif}.eyebrow{font-size:12px;letter-spacing:.1em;font-weight:700}.scope{background:#eaf0e4;border-left:3px solid #8eab92;padding:16px 20px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;background:#fffefa}td,th{text-align:left;padding:16px;border-bottom:1px solid #d4dfcf}th{font-size:12px;text-transform:uppercase;background:#e8eee2}a{color:#17624d}a:focus-visible{outline:3px solid #a76c19;outline-offset:4px}.pass{color:#245631;font-weight:700}.attention{color:#922f24;font-weight:700}small{color:#60756b}code{overflow-wrap:anywhere}footer{margin-top:28px;border-top:1px solid #ccd8ca;font-size:13px}</style></head><body><main><span class="eyebrow">MIDBRAIN / ENGINEERING</span><h1>MCP review evidence</h1><p>Recorded integration checks, with the native client, host and outcome kept visible.</p><div class="scope"><strong>Review evidence — not release sign-off.</strong> Dry-smoke tests MCP contracts and native discovery. Scripted-smoke tests native dispatch with a local deterministic provider. Neither runs LLM inference or verifies production memory quality.</div><h2>Included runs</h2><div class="scroll"><table><thead><tr><th>Run and native clients</th><th>Test outcome</th><th>Assertions passed</th><th>Actual host</th></tr></thead><tbody>${rows}</tbody></table></div><h2>Verify before review</h2><p>Run <code>node harness/run.mjs verify-review /path/to/this-bundle</code> from the repository. Verification checks file inventory, SHA-256 hashes, report outcomes and linked evidence. A valid bundle can contain failed or incomplete tests.</p><p>Checksums detect changes; they do not authenticate the author or independently rerun the tests. Read <a href="README.md">the review notes</a> and <a href="manifest.json">the manifest</a> for provenance and boundaries.</p><footer><p>Offline report · no external assets · private test homes and configurations excluded.</p></footer></main></body></html>`;
}

function runSummary(report, directory, sourceResultsSha256) {
  const checks = report.cells.flatMap(c => c.checks || []);
  return { directory, runId: report.run.runId, kind: report.run.kind, clients: report.clients.map(c => `${c.displayName || c.id}${c.version ? ` ${String(c.version).split(/\r?\n/)[0]}` : ''}`), host: `${report.run.platform}/${report.run.arch}`, outcome: outcome(report), assertions: checks.length, passed: checks.filter(c => c.ok === true).length, sourceResultsSha256 };
}

export function exportReviewBundle(runDirectories, output) {
  if (!Array.isArray(runDirectories) || runDirectories.length < 1 || runDirectories.length > 20 || !output) throw new Error('Provide 1–20 source run directories and a new output directory');
  const roots = runDirectories.map(dir => fs.realpathSync(dir));
  if (new Set(roots).size !== roots.length) throw new Error('Duplicate source run');
  const dest = path.resolve(output);
  if (fs.existsSync(dest)) throw new Error('Output already exists; choose a new directory');
  const parent = fs.realpathSync(path.dirname(dest)); const canonicalDest = path.join(parent, path.basename(dest));
  if (roots.some(root => canonicalDest === root || canonicalDest.startsWith(root + path.sep))) throw new Error('Review output must be outside every source run');
  const files = new Map(); const runs = []; let total = 0;
  const add = (name, value, original) => {
    const bytes = Buffer.from(value); total += bytes.length;
    if (bytes.length > MAX_FILE || total > MAX_TOTAL) throw new Error('Review bundle exceeds size limits');
    files.set(name, { bytes, ...(original ? { sourceSha256: sha(original) } : {}) });
  };
  for (const [i, root] of roots.entries()) {
    const directory = `runs/${String(i + 1).padStart(2, '0')}`;
    const raw = fs.readFileSync(localFile(root, 'results.json')); const source = JSON.parse(raw);
    const verdict = outcome(source); const refs = references(source);
    for (const ref of refs) if (!fs.existsSync(path.join(root, ref))) throw new Error(`Missing linked evidence: ${ref}`);
    const report = scrub(source);
    if (outcome(report) !== verdict) throw new Error('Redaction changed the test outcome');
    const selected = inventory(root, true);
    for (const ref of refs) if (!selected.includes(ref)) throw new Error(`Missing selected evidence: ${ref}`);
    for (const name of selected) {
      const original = fs.readFileSync(localFile(root, name)); add(`${directory}/${name}`, redactFile(name, original), original);
    }
    add(`${directory}/results.json`, encode(report), raw);
    add(`${directory}/candidate.json`, encode(report.candidate || {}));
    add(`${directory}/isolation.json`, encode(report.isolation));
    add(`${directory}/report.html`, renderRunHtml(report));
    add(`${directory}/report.md`, renderMarkdown(report));
    add(`${directory}/junit.xml`, report.run.kind === 'dry-smoke' ? renderDrySmokeJUnit(report) : renderScriptedJUnit(report));
    runs.push(runSummary(report, directory, sha(raw)));
  }
  add('index.html', overview(runs));
  add('README.md', '# MidBrain MCP review bundle\n\nOpen index.html to compare the included runs. Test outcomes remain separate from bundle integrity. This is review evidence, not release sign-off.\n\nVerify with:\n\n    node harness/run.mjs verify-review /path/to/bundle\n\nThe manifest records SHA-256 hashes, file sizes and source-file hashes where evidence was redacted. Checksums detect changes, not authorship or truthful test execution. Obtain the bundle through a trusted channel.\n\nOnly dry-smoke and scripted-smoke are supported. No clients run during export. Reports are regenerated from recorded results; source runs are unchanged. Private test homes, configuration files, candidate code, dependencies and caches are excluded. Synthetic keys and common credential formats are redacted; tool schemas remain intact. Review fixture text before distributing it: unknown secrets manually inserted into arbitrary text are not guaranteed to be recognized. Failed and incomplete runs remain visibly failed or incomplete. Native validation applies only to the recorded hosts and client versions.\n');
  const manifest = { schemaVersion: 1, kind: 'midbrain-mcp-review', generatedAt: new Date().toISOString(), runs, files: Object.fromEntries([...files].map(([name, file]) => [name, { sha256: sha(file.bytes), bytes: file.bytes.length, ...(file.sourceSha256 ? { sourceSha256: file.sourceSha256 } : {}) }])) };
  const stage = fs.mkdtempSync(path.join(parent, '.mcp-review-')); let reserved = false;
  try {
    for (const [name, file] of files) { const target = path.join(stage, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file.bytes, { mode: 0o600 }); }
    fs.writeFileSync(path.join(stage, 'manifest.json'), encode(manifest), { mode: 0o600 });
    const verified = verifyReviewBundle(stage); if (!verified.ok) throw new Error(`Review verification failed: ${verified.problems.join('; ')}`);
    // Reserve exclusively, then move children: Windows cannot rename over an
    // existing directory. Publish the manifest last so partial output cannot verify.
    fs.mkdirSync(dest); reserved = true;
    for (const name of fs.readdirSync(stage).filter(name => name !== 'manifest.json')) fs.renameSync(path.join(stage, name), path.join(dest, name));
    fs.renameSync(path.join(stage, 'manifest.json'), path.join(dest, 'manifest.json'));
    reserved = false;
    return { directory: dest, index: path.join(dest, 'index.html'), runs, files: files.size };
  } finally { fs.rmSync(stage, { recursive: true, force: true }); if (reserved) fs.rmSync(dest, { recursive: true, force: true }); }
}

export function verifyReviewBundle(directory) {
  const problems = []; let manifest; let runs = [];
  try {
    const root = fs.realpathSync(directory);
    manifest = JSON.parse(fs.readFileSync(localFile(root, 'manifest.json'), 'utf8'));
    if (manifest.schemaVersion !== 1 || manifest.kind !== 'midbrain-mcp-review' || !Array.isArray(manifest.runs) || !manifest.runs.length || !manifest.files || typeof manifest.files !== 'object') throw new Error('Unsupported review manifest');
    const actual = inventory(root); const listed = Object.keys(manifest.files);
    let total = 0;
    for (const name of listed) {
      safeRelative(name);
      try {
        const bytes = fs.readFileSync(localFile(root, name)); total += bytes.length;
        if (total > MAX_TOTAL) throw new Error('Bundle exceeds size limit');
        if (manifest.files[name].sha256 !== sha(bytes) || manifest.files[name].bytes !== bytes.length) problems.push(`Changed file: ${name}`);
      } catch (error) { problems.push(`Missing or unsafe file: ${name} (${error.message})`); }
    }
    for (const name of actual) if (name !== 'manifest.json' && !listed.includes(name)) problems.push(`Unlisted file: ${name}`);
    if (new Set(manifest.runs.map(r => r.directory)).size !== manifest.runs.length) problems.push('Duplicate run directory');
    for (const run of manifest.runs) {
      if (!/^runs\/[0-9]{2}$/.test(run.directory)) throw new Error('Unsafe run directory');
      const name = `${run.directory}/results.json`;
      if (!manifest.files[name]) throw new Error('Unlisted run results');
      const report = JSON.parse(fs.readFileSync(localFile(root, name), 'utf8'));
      if (!isDeepStrictEqual(runSummary(report, run.directory, run.sourceResultsSha256), run)) problems.push(`Run summary differs from results: ${run.directory}`);
      if (manifest.files[name].sourceSha256 !== run.sourceResultsSha256) problems.push(`Source provenance differs: ${run.directory}`);
      for (const ref of references(report)) if (!manifest.files[`${run.directory}/${ref}`]) problems.push(`Missing linked evidence: ${ref}`);
    }
    for (const name of listed.filter(n => n.endsWith('.html'))) {
      const html = fs.readFileSync(localFile(root, name), 'utf8');
      for (const match of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)) {
        const href = match[1]; if (href.startsWith('#') || /^https?:\/\//.test(href)) continue;
        const relative = safeRelative(href.split('#')[0]);
        const linked = path.posix.join(path.posix.dirname(name), relative);
        if (!manifest.files[linked] && linked !== 'manifest.json') problems.push(`Missing report link: ${linked}`);
      }
    }
    runs = manifest.runs;
  } catch (error) { problems.push(error.message); }
  return { ok: problems.length === 0, problems, runs };
}
