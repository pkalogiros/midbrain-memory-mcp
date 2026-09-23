import path from 'node:path';
import { readFileSync } from 'node:fs';
import { spawnCapture } from './proc.mjs';
import hermes, { parseSessionExport, parseHermesToolPayload } from '../clients/hermes.mjs';
import pi, { piEvent } from '../clients/pi.mjs';
import opencode, { toolCall } from '../clients/opencode.mjs';

export const SCRIPTED_CLIENTS = ['pi', 'opencode', 'hermes'];
export function scriptedClient(id = 'pi') {
  const client = { pi, opencode, hermes }[id];
  if (!client) throw new Error(`Unsupported scripted client: ${id}`);
  return client;
}
export function scriptedToolName(id, name, target) {
  scriptedClient(id);
  if (target === 'peer') {
    if (id !== 'opencode') throw new Error('Peer routing scenario requires OpenCode');
    return `scripted-peer_${name}`;
  }
  if (id === 'hermes') return `mcp__midbrain_memory__${name}`;
  return `${id === 'pi' ? 'midbrain_' : 'midbrain-memory_'}${name}`;
}
export function scriptedClientConfig(id, baseUrl, current = {}) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Scripted provider must use HTTP loopback');
  scriptedClient(id);
  if (id === 'hermes') return { ...current,
    model: { provider: 'custom', default: 'mcp-script', base_url: baseUrl, api_key: 'local-scripted-dummy', context_length: 128000 },
    agent: { max_turns: 16 }, compression: { enabled: false },
    tools: { tool_search: { enabled: 'off' } },
  };
  if (id === 'pi') return { providers: { 'midbrain-scripted': { baseUrl, api: 'openai-completions', apiKey: 'local-scripted-dummy', models: [{ id: 'mcp-script', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } };
  return { ...current, model: 'midbrain-scripted/mcp-script', small_model: 'midbrain-scripted/mcp-script', enabled_providers: ['midbrain-scripted'], autoupdate: false, share: 'disabled',
    compaction: { auto: false, prune: false }, agent: { title: { disable: true }, summary: { disable: true } },
    provider: { 'midbrain-scripted': { npm: '@ai-sdk/openai-compatible', name: 'Local scripted MCP test', options: { baseURL: baseUrl, apiKey: 'local-scripted-dummy' }, models: { 'mcp-script': { name: 'Scripted MCP calls (no LLM)', limit: { context: 128000, output: 1024 } } } } },
  };
}
export function scriptedArgs(id, project, prompt) {
  if (id === 'hermes') return ['chat', '-q', prompt, '-Q', '--provider', 'custom', '-m', 'mcp-script', '--pass-session-id'];
  return id === 'pi' ? ['-p', '--mode', 'json', '--approve', '--provider', 'midbrain-scripted', '--model', 'mcp-script', '--', prompt]
    : ['run', '--format', 'json', '--dir', project, '--model', 'midbrain-scripted/mcp-script', prompt];
}
export function scriptedNativeEvent(id, turn, event, ctx, evidenceDir) {
  if (id === 'pi') return piEvent(turn, event);
  if (event.type === 'error') { turn.isError = true; turn.errorDetail = JSON.stringify(event.error || event); }
  if (event.type === 'text' && typeof event.part?.text === 'string') {
    if (turn.messageId !== event.part.messageID) turn.finalText = '';
    turn.messageId = event.part.messageID; turn.finalText += event.part.text;
  }
  if (event.type === 'tool_use' && event.part?.type === 'tool') {
    const call = toolCall(event.part, ctx, evidenceDir, 'native');
    const existing = turn.toolCalls.findIndex(c => c.id === call.id);
    if (existing < 0) turn.toolCalls.push(call); else turn.toolCalls[existing] = call;
  }
}

export function scriptedNativeEnv(id, baseUrl) {
  return id === 'hermes' ? { OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: 'local-scripted-dummy', HERMES_INTERACTIVE: '0', HERMES_ACCEPT_HOOKS: '1' } : {};
}

export async function collectScriptedNative(id, binary, result, turn, { project, env, evidenceDir, prompt }) {
  if (id !== 'hermes') return;
  const match = `${result.stdout}\n${result.stderr}`.match(/\b(?:session[_ -]?id|session)\b[^A-Za-z0-9_-]{0,6}([A-Za-z0-9_-]{8,})/i);
  if (!match) throw new Error('Hermes did not report a session ID; native tool evidence is unavailable');
  turn.sessionId = match[1];
  const file = path.join(evidenceDir, 'native-session.jsonl');
  const exported = await spawnCapture(binary, ['sessions', 'export', '--format', 'jsonl', '--session-id', turn.sessionId, '--yes', '--no-redact', file], { cwd: project, env, timeoutMs: 15000 });
  if (exported.code !== 0) throw new Error('Hermes session export failed; native receipts were not inferred from provider output');
  Object.assign(turn, parseSessionExport(readFileSync(file, 'utf8'), prompt));
}

export function scriptedResultText(id, result) {
  if (id === 'hermes' && typeof result === 'string') {
    const body = parseHermesToolPayload(result);
    if (typeof body?.result === 'string') return body.result;
    if (typeof body?.error === 'string') return body.error;
  }
  return typeof result === 'string' ? result : result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || '';
}
