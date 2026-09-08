import claude from './claude.mjs';
import codex from './codex.mjs';
import opencode from './opencode.mjs';
import hermes from './hermes.mjs';
import nanoclaw from './nanoclaw.mjs';

export const MANIFESTS = { opencode, claude, codex, hermes, nanoclaw };
export const ORDER = ['opencode', 'claude', 'codex', 'hermes', 'nanoclaw'];

export function selectManifests(ids) {
  const wanted = ids && ids.length ? ids : ORDER;
  const unknown = wanted.filter((id) => !MANIFESTS[id]);
  if (unknown.length) throw new Error(`unknown client id(s): ${unknown.join(', ')} (known: ${ORDER.join(', ')})`);
  return ORDER.filter((id) => wanted.includes(id)).map((id) => MANIFESTS[id]);
}
