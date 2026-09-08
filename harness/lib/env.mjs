// Minimal .env loader. Values are placed into process.env only when absent so
// a runner's real environment always wins. Secrets are never printed.
import { existsSync, readFileSync } from 'node:fs';

export function loadDotEnv(file) {
  if (!existsSync(file)) return [];
  const loaded = [];
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  return loaded;
}

const PLACEHOLDER_RE = /^<.*>$|REPLACE_ME|^your[-_]|^paste[-_]|^xxx+$/i;

export function isPlaceholder(value) {
  return PLACEHOLDER_RE.test(String(value || '').trim());
}

export function secretPresent(name) {
  const v = (process.env[name] || '').trim();
  return Boolean(v) && !isPlaceholder(v);
}

export const SECRET_NAMES = [
  'MIDBRAIN_HARNESS_API_KEY',
  'MIDBRAIN_HARNESS_PROJECT_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
];

export function collectSecrets() {
  const out = {};
  for (const name of SECRET_NAMES) {
    const v = (process.env[name] || '').trim();
    if (v && !isPlaceholder(v)) out[name] = v;
  }
  return out;
}
