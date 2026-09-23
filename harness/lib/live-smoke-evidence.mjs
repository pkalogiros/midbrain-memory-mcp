import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseSmokeTrace } from './dry-smoke-trace.mjs';

export function readLiveTrace(dir) {
  const result = { calls: [], discoveries: [], issues: [] };
  for (const name of readdirSync(dir).filter(f => f.endsWith('.ndjson')).sort()) {
    const lines = readFileSync(path.join(dir, name), 'utf8').split('\n');
    const data = [];
    for (const line of lines) {
      try { const event = JSON.parse(line); if (event.type === 'trace.issue') { result.issues.push(event.message); continue; } } catch { /* Let the strict parser diagnose it. */ }
      data.push(line);
    }
    const parsed = parseSmokeTrace(data.join('\n'));
    result.calls.push(...parsed.calls); result.discoveries.push(...parsed.discoveries); result.issues.push(...parsed.issues);
  }
  result.calls.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  result.limitExceeded = result.issues.includes('MCP call budget exceeded');
  return result;
}

export function redactLive(value, secrets = []) {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  for (const secret of [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('[redacted credential]');
    text = text.split(encodeURIComponent(secret)).join('[redacted credential]');
  }
  return text;
}

/** Native artifacts stay private while a process runs; scrub before linking reports. */
export function redactLiveDirectory(dir, secrets) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) redactLiveDirectory(file, secrets);
    else if (entry.isFile() && /\.(json|jsonl|ndjson|txt|md|xml|html)$/.test(entry.name)) writeFileSync(file, redactLive(readFileSync(file, 'utf8'), secrets), { mode: 0o600 });
  }
}
