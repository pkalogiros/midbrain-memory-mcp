// Transparent stdio recorder. Discovery/result payloads are passed through unchanged.
// Only the explicit test tool may execute, with an atomic run-wide call budget.
import { spawn } from 'node:child_process';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const allowedTools = config.allowedTools || ['memory_search'];
const file = path.join(config.traceDir, `${process.pid}.ndjson`);
const events = event => appendFileSync(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(ANTHROPIC|OPENAI|AZURE|GOOGLE|GEMINI|AWS|OPENROUTER)_/.test(key)) delete env[key];
// The native client already applied the original integration env (including cwd).
const child = spawn(config.entry.command, config.entry.args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const pending = new Map();
let closing = false;
let discovery;
const stop = () => { if (closing) return; closing = true; child.stdin.end(); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 1000).unref(); };
const issue = message => events({ type: 'trace.issue', message });
const reserve = () => {
  for (let i = 1; i <= config.maxMcpCalls; i++) {
    try { mkdirSync(path.join(config.traceDir, `slot-${i}`)); return true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  return false;
};
createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { issue('Invalid JSON from native client'); stop(); return; }
  if (message.method === 'tools/call') {
    if ([...pending.values()].some(p => p.call)) issue('Concurrent tool calls do not prove sequential error recovery');
    const call = { id: `${process.pid}-${message.id}`, name: message.params?.name, args: message.params?.arguments || {}, connection: process.pid, status: 'pending', startedAt: new Date().toISOString() };
    events({ type: 'call.started', call });
    if (!reserve() || !allowedTools.includes(call.name)) {
      issue(!allowedTools.includes(call.name) ? `Unplanned tool: ${call.name}` : 'MCP call budget exceeded');
      const result = { content: [{ type: 'text', text: 'Live-smoke stopped: tool not allowed or call budget exceeded.' }], isError: true };
      events({ type: 'call.finished', call: { ...call, status: 'tool-error', result, completedAt: new Date().toISOString() } });
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
      stop(); return;
    }
    if (pending.has(message.id)) { issue('Duplicate in-flight JSON-RPC ID'); stop(); return; }
    pending.set(message.id, { call, start: Date.now() });
  } else if (message.method === 'tools/list') pending.set(message.id, { discovery: true });
  if (!closing) child.stdin.write(line + '\n');
}).on('close', stop);
createInterface({ input: child.stdout }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { issue('Non-JSON output from MCP server'); stop(); return; }
  const saved = pending.get(message.id);
  if (saved?.discovery && Array.isArray(message.result?.tools)) {
    const schemas = JSON.stringify(message.result.tools);
    if (!discovery) events({ type: 'tools.discovered', discovery: { connection: process.pid, tools: message.result.tools } });
    else if (discovery !== schemas) issue('Tool definitions changed during the session');
    discovery = schemas;
  }
  if (saved?.call) {
    const call = { ...saved.call, completedAt: new Date().toISOString(), durationMs: Date.now() - saved.start,
      ...(message.error ? { status: 'rejected', error: message.error } : { status: message.result?.isError ? 'tool-error' : 'returned', result: message.result }) };
    events({ type: 'call.finished', call });
  }
  pending.delete(message.id);
  process.stdout.write(line + '\n');
});
child.stderr.pipe(process.stderr);
child.stdin.on('error', error => { issue(`MCP stdin closed: ${error.code}`); });
child.on('error', error => { issue(`MCP launch failed: ${error.message}`); process.exitCode = 1; process.stdin.destroy(); });
child.on('close', code => { if (code && !closing) issue(`MCP exited ${code}`); process.exitCode = code || 0; process.stdin.destroy(); });
process.once('SIGTERM', stop); process.once('SIGINT', stop);
