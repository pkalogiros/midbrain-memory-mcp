import path from 'node:path';
import claude from '../clients/claude.mjs';
import codex, { recordCodexOutcome } from '../clients/codex.mjs';
import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { spawnCapture } from './proc.mjs';
import hermes, { parseSessionExport, parseHermesToolPayload } from '../clients/hermes.mjs';
import pi, { piEvent } from '../clients/pi.mjs';
import opencode, { toolCall } from '../clients/opencode.mjs';

export const SCRIPTED_CLIENTS = ['pi', 'opencode', 'hermes', 'claude', 'codex'];
export function scriptedClient(id = 'pi') {
  const client = { pi, opencode, hermes, claude, codex }[id];
  if (!client) throw new Error(`Unsupported scripted client: ${id}`);
  return client;
}
export function scriptedToolName(id, name, target) {
  scriptedClient(id);
  if (target === 'peer') {
    if (id !== 'opencode') throw new Error('Peer routing scenario requires OpenCode');
    return `scripted-peer_${name}`;
  }
  if (id === 'hermes' || id === 'codex') return `mcp__midbrain_memory__${name}`;
  if (id === 'claude') return `mcp__midbrain-memory__${name}`;
  return `${id === 'pi' ? 'midbrain_' : 'midbrain-memory_'}${name}`;
}
export function scriptedClientConfig(id, baseUrl, current = {}) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw new Error('Scripted provider must use HTTP loopback');
  scriptedClient(id);
  if (id === 'claude') return { ...current, env: { ...current.env, ...scriptedNativeEnv(id, baseUrl) } };
  if (id === 'codex') return { ...current, model: 'mcp-script', model_provider: 'midbrain_scripted', model_context_window: 128000, model_auto_compact_token_limit: 120000,
    model_providers: { midbrain_scripted: { name: 'Local scripted MCP test', base_url: baseUrl, wire_api: 'responses', requires_openai_auth: false, supports_websockets: false, request_max_retries: 0, stream_max_retries: 0, stream_idle_timeout_ms: 15000 } },
  };
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
  if (id === 'claude') return ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--model', 'mcp-script', '--max-turns', '16', '--permission-mode', 'dontAsk', '--allowedTools', 'mcp__midbrain-memory__*'];
  if (id === 'codex') return ['exec', '--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '-C', project, '-m', 'mcp-script', prompt];
  if (id === 'hermes') return ['chat', '-q', prompt, '-Q', '--provider', 'custom', '-m', 'mcp-script', '--pass-session-id'];
  return id === 'pi' ? ['-p', '--mode', 'json', '--approve', '--provider', 'midbrain-scripted', '--model', 'mcp-script', '--', prompt]
    : ['run', '--format', 'json', '--dir', project, '--model', 'midbrain-scripted/mcp-script', prompt];
}
export function scriptedNativeEvent(id, turn, event, ctx, evidenceDir) {
  if (id === 'pi') return piEvent(turn, event);
  if (id === 'claude') {
    if (event.type === 'assistant') for (const b of event.message?.content || []) {
      if (b.type === 'tool_use') turn.toolCalls.push({ id: b.id, name: b.name, input: b.input, result: null, ok: null });
    }
    if (event.type === 'user') for (const b of event.message?.content || []) {
      if (b.type === 'tool_result') { const call = turn.toolCalls.find(c => c.id === b.tool_use_id); if (call) { call.result = Array.isArray(b.content) ? b.content.map(c => c.text || '').join('\n') : b.content; call.ok = b.is_error !== true; } }
    }
    if (event.type === 'result') { turn.finalText = String(event.result ?? ''); turn.isError = Boolean(event.is_error); }
    return;
  }
  if (id === 'codex') {
    recordCodexOutcome(turn, event);
    if (event.type === 'thread.started') turn.sessionId = event.thread_id;
    if (event.type === 'item.completed') {
      const item = event.item || {};
      if (item.type === 'mcp_tool_call') turn.toolCalls.push(codexNativeCall(item));
      else if (item.type === 'agent_message') turn.finalText = String(item.text ?? '');
      else if (['command_execution', 'file_change', 'web_search'].includes(item.type)) turn.toolCalls.push({ id: item.id, name: item.type, input: item, result: null, ok: false });
    }
    return;
  }
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
  if (id === 'claude') return { ANTHROPIC_BASE_URL: baseUrl.replace(/\/v1$/, ''), ANTHROPIC_API_KEY: 'local-scripted-dummy', ANTHROPIC_MODEL: 'mcp-script', ANTHROPIC_SMALL_FAST_MODEL: 'mcp-script', CLAUDE_CODE_SUBAGENT_MODEL: 'mcp-script', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_AUTO_COMPACT: '1', ENABLE_TOOL_SEARCH: 'false', MAX_THINKING_TOKENS: '0' };
  return id === 'hermes' ? { OPENAI_BASE_URL: baseUrl, OPENAI_API_KEY: 'local-scripted-dummy', HERMES_INTERACTIVE: '0', HERMES_ACCEPT_HOOKS: '1' } : {};
}

export async function collectScriptedNative(id, binary, result, turn, { project, env, evidenceDir, prompt }) {
  if (id === 'codex') {
    if (!/^[a-zA-Z0-9-]+$/.test(turn.sessionId || '')) throw new Error('Codex did not report a session ID');
    const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : e.isFile() && e.name.endsWith(`-${turn.sessionId}.jsonl`) ? [path.join(dir, e.name)] : []);
    const files = walk(path.join(env.CODEX_HOME, 'sessions'));
    if (files.length !== 1 || statSync(files[0]).size > 16 * 1024 * 1024) throw new Error('Codex native session is missing, ambiguous or exceeds 16 MiB');
    const raw = readFileSync(files[0], 'utf8');
    writeFileSync(path.join(evidenceDir, 'native-session.jsonl'), raw, { mode: 0o600 });
    correlateCodexSession(turn, raw); return;
  }
  if (id !== 'hermes') return;
  const match = `${result.stdout}\n${result.stderr}`.match(/\b(?:session[_ -]?id|session)\b[^A-Za-z0-9_-]{0,6}([A-Za-z0-9_-]{8,})/i);
  if (!match) throw new Error('Hermes did not report a session ID; native tool evidence is unavailable');
  turn.sessionId = match[1];
  const file = path.join(evidenceDir, 'native-session.jsonl');
  const exported = await spawnCapture(binary, ['sessions', 'export', '--format', 'jsonl', '--session-id', turn.sessionId, '--yes', '--no-redact', file], { cwd: project, env, timeoutMs: 15000 });
  if (exported.code !== 0) throw new Error('Hermes session export failed; native receipts were not inferred from provider output');
  Object.assign(turn, parseSessionExport(readFileSync(file, 'utf8'), prompt));
}

function codexNativeCall(item) {
  return { id: item.id, name: `mcp__${String(item.server).replace(/[^a-zA-Z0-9_]/g, '_')}__${item.tool}`, server: item.server, input: item.arguments, result: item.result ?? item.error, ok: item.status === 'completed' && !item.error && item.result?.isError !== true && item.result?.is_error !== true };
}

// CLI item IDs differ from provider IDs. The native rollout records both the
// real MCP completion and its provider ID; never reconstruct IDs from the plan.
export function correlateCodexSession(turn, raw) {
  const rows = raw.trim().split('\n').map(line => JSON.parse(line));
  const metadata = rows.filter(r => r.type === 'session_meta');
  if (metadata.length !== 1 || metadata[0].payload?.id !== turn.sessionId) throw new Error('Codex session identity mismatch');
  const events = rows.filter(r => r.type === 'event_msg' && r.payload?.type === 'item_completed' && r.payload.item?.type === 'McpToolCall');
  if (events.length !== turn.toolCalls.length || events.some(e => e.payload.thread_id !== turn.sessionId)) throw new Error('Codex session/CLI call count or identity mismatch');
  const calls = events.map(e => codexNativeCall(e.payload.item));
  if (new Set(calls.map(c => c.id)).size !== calls.length) throw new Error('Codex session repeats a call ID');
  for (const [i, call] of calls.entries()) {
    const cli = turn.toolCalls[i];
    if (call.server !== cli.server || call.name !== cli.name || !isDeepStrictEqual(call.input, cli.input) || call.ok !== cli.ok || scriptedResultText('codex', call.result) !== scriptedResultText('codex', cli.result)) throw new Error('Codex session/CLI tool receipt mismatch');
    call.stdoutItemId = cli.id;
  }
  turn.toolCalls = calls;
}

export function scriptedResultText(id, result) {
  if (id === 'codex' && typeof result === 'string') {
    const match = result.match(/^Wall time: [\d.]+ seconds\nOutput:\n([\s\S]+)$/);
    if (match) {
      try { const content = JSON.parse(match[1]); if (Array.isArray(content) && content.every(c => c.type === 'text' && typeof c.text === 'string')) return content.map(c => c.text).join('\n'); } catch { /* Preserve malformed output so correlation fails. */ }
    }
  }
  if (id === 'hermes' && typeof result === 'string') {
    const body = parseHermesToolPayload(result);
    if (typeof body?.result === 'string') return body.result;
    if (typeof body?.error === 'string') return body.error;
  }
  return typeof result === 'string' ? result : result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || '';
}
