import http from 'node:http';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { TOOL_CONTRACTS, checkToolSchema } from './tool-contracts.mjs';
import { SMOKE_KEYS } from './dry-smoke-fixture.mjs';
import { SCRIPTED_CLIENTS, scriptedToolName, scriptedResultText } from './scripted-smoke-clients.mjs';

export const SCRIPTED_ROWS = ['Installation', 'Native tool round trips', 'Failure recovery'];
export const SCRIPTED_SCOPE = 'Real native client and installed MCP, local scripted provider and synthetic backend. Zero LLM inference. Tests tool discovery, argument dispatch and result delivery through the selected client; does not test model reasoning, spontaneous tool selection or memory quality. Supports Pi, OpenCode and Hermes, one client per run; other clients require separate adapters and native validation.';
export function validateScriptedFlags(flags) {
  for (const key of Object.keys(flags)) if (!['_', 'clients', 'root', 'install-clients'].includes(key)) throw new Error(`scripted-smoke does not accept --${key}`);
  if (flags._?.length) throw new Error('scripted-smoke takes no positional arguments');
  if (flags.clients !== undefined && !SCRIPTED_CLIENTS.includes(flags.clients)) throw new Error('Scripted-smoke supports Pi, OpenCode and Hermes; select one client per run (--clients pi, --clients opencode or --clients hermes).');
  if (flags.root !== undefined && (typeof flags.root !== 'string' || !flags.root.trim())) throw new Error('--root requires a directory');
  if (flags['install-clients'] !== undefined && flags['install-clients'] !== true) throw new Error('--install-clients is a boolean flag');
}

export function scriptedPlan(project, client = 'pi') {
  const plan = [
    { name: 'memory_search', args: { query: 'DRY_SMOKE_SCRIPTED', memory_type: 'semantic', limit: 3 }, contains: 'fixture reply: DRY_SMOKE_SCRIPTED' },
    { name: 'grep', args: { pattern: 'fixture.*', memory_type: 'semantic', limit: 2 }, contains: 'fixture lexical match' },
    { name: 'get_episodic_memories_by_date', args: { date: '2026-01-01', offset_days: 2 }, contains: '2026-01-03' },
    { name: 'list_files', args: {}, contains: 'guide.md' },
    { name: 'read_file', args: { file_path: 'guide.md', start_line: 2, num_lines: 1 }, contains: '2: fixture file content' },
    { name: 'check_session_status', args: {}, contains: 'No episodic memories' },
    { name: 'memory_diagnostics', args: { probe: false }, contains: '127.0.0.1' },
    { name: 'set_user_api_key', args: { user_api_key: SMOKE_KEYS.user }, contains: 'saved' },
    { name: 'list_agents', args: {}, contains: 'dry-agent' },
    { name: 'create_agent', args: { name: 'Dry smoke agent' }, contains: 'Created agent' },
    { name: 'set_agent', args: { agent: 'dry-agent', project_dir: path.join(project, 'selected-agent') }, contains: 'now set' },
    { name: 'memory_setup_project', args: { project_dir: path.join(project, 'setup-project'), api_key: SMOKE_KEYS.project }, contains: 'restart' },
    { name: 'memory_search', args: { query: 'DRY_SMOKE_UNAVAILABLE', memory_type: 'semantic' }, contains: '503', recovery: true },
    { name: 'memory_search', args: { query: 'DRY_SMOKE_SCRIPTED_RECOVERED', memory_type: 'semantic' }, contains: 'fixture reply: DRY_SMOKE_SCRIPTED_RECOVERED', recovery: true },
  ];
  if (client === 'opencode') plan.push({ name: 'memory_search', target: 'peer', args: { query: 'SCRIPTED_PEER_ONLY' }, contains: 'SCRIPTED_PEER_RESPONSE' });
  return plan;
}

/** A deterministic provider endpoint, never a model. Advance only on the
 * correlated result sent back by the real native client. */
export async function startScriptedProvider(plan, record = () => {}, client = 'pi') {
  const toolName = (name, target) => scriptedToolName(client, name, target);
  const attempts = []; const requests = []; const receipts = []; const issues = [];
  let discoveryCount = 0;
  let issued = 0; let complete = false; let busy = false;
  const server = http.createServer(async (req, res) => {
    const attempt = { index: attempts.length + 1, receivedAt: new Date().toISOString(), method: req.method, path: req.url.split('?')[0], status: 'pending' };
    attempts.push(attempt);
    record({ type: 'provider.attempt', attempt: { ...attempt } });
    const reject = message => { Object.assign(attempt, { status: 'rejected', error: message }); issues.push(message); record({ type: 'provider.issue', attemptIndex: attempt.index, message }); res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message, type: 'scripted_contract_error' } })); };
    // Hermes probes local provider capabilities before its first completion.
    // Those reads are recorded separately and cannot advance the tool script.
    if (client === 'hermes' && req.method === 'GET') {
      if (++discoveryCount > 16) return reject('Provider discovery limit exceeded (16 reads)');
      attempt.kind = 'discovery'; attempt.status = 'answered';
      const catalog = attempt.path === '/v1/models';
      attempt.httpStatus = catalog ? 200 : 404;
      res.writeHead(attempt.httpStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(catalog ? { object: 'list', data: [{ id: 'mcp-script', object: 'model', owned_by: 'local-script' }] } : { error: { message: 'Capability not implemented by local script' } }));
      record({ type: 'provider.discovery', attempt: { ...attempt } });
      return;
    }
    if (busy || complete || issues.length || requests.length >= plan.length + 1) return reject('Unexpected concurrent, repeated or excess provider request');
    busy = true;
    try {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') throw new Error('Only local chat completions are supported');
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) throw new Error('Provider body exceeds 4 MiB'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ index: requests.length + 1, attemptIndex: attempt.index, receivedAt: attempt.receivedAt, body });
      record({ type: 'provider.request', request: requests.at(-1) });
      if (body.model !== 'mcp-script' || !Array.isArray(body.messages)) throw new Error('Unexpected model or messages');
      const tools = body.tools || [];
      for (const tool of TOOL_CONTRACTS) {
        const matches = tools.filter(t => t.function?.name === toolName(tool.name));
        if (matches.length !== 1 || checkToolSchema(tool.name, matches[0]?.function?.parameters).length) throw new Error(`Missing or changed provider tool schema: ${tool.name}`);
      }
      if (plan.some(step => step.target === 'peer')) {
        const matches = tools.filter(t => t.function?.name === toolName('memory_search', 'peer'));
        if (matches.length !== 1 || matches[0].function.parameters?.properties?.query?.type !== 'string' || !matches[0].function.parameters.required?.includes('query')) throw new Error('Missing or changed namespaced peer schema');
      }
      if (issued) {
        const id = `script-call-${issued}`; const step = plan[issued - 1];
        const results = body.messages.filter(m => m.role === 'tool' && m.tool_call_id === id);
        const calls = body.messages.flatMap(m => m.role === 'assistant' ? m.tool_calls || [] : []).filter(c => c.id === id);
        if (results.length !== 1 || calls.length !== 1 || calls[0].function?.name !== toolName(step.name, step.target) || !isDeepStrictEqual(JSON.parse(calls[0].function.arguments), step.args)) throw new Error(`Missing or mismatched tool correlation: ${id}`);
        const content = typeof results[0].content === 'string' ? results[0].content : JSON.stringify(results[0].content);
        if (!content.includes(step.contains)) throw new Error(`Unexpected result for ${step.name}: expected ${step.contains}`);
        receipts.push({ id, name: step.name, args: step.args, content, receivedAt: new Date().toISOString() });
        record({ type: 'provider.receipt', receipt: receipts.at(-1) });
      }
      const step = plan[issued];
      const toolCalls = step ? [{ id: `script-call-${++issued}`, type: 'function', function: { name: toolName(step.name, step.target), arguments: JSON.stringify(step.args) } }] : null;
      const message = toolCalls ? { role: 'assistant', content: null, tool_calls: toolCalls } : { role: 'assistant', content: 'SCRIPTED_MCP_COMPLETE' };
      const finish = toolCalls ? 'tool_calls' : 'stop';
      const common = { id: `script-response-${requests.length}`, created: Math.floor(Date.now() / 1000), model: 'mcp-script' };
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        const delta = toolCalls ? { role: 'assistant', tool_calls: toolCalls.map((c, index) => ({ index, ...c })) } : message;
        for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: finish }]) res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [choice] })}\n\n`);
        res.end('data: [DONE]\n\n');
      } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }] })); }
      attempt.status = 'accepted';
      record({ type: 'provider.accepted', attemptIndex: attempt.index });
      if (!step) complete = true;
    } catch (error) { reject(error.message); } finally { busy = false; }
  });
  server.requestTimeout = 15000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/v1`, attempts, requests, receipts, issues, get complete() { return complete; },
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

const text = result => typeof result === 'string' ? result : result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n') || '';
const normalizedArgs = (name, args) => ({ ...Object.fromEntries(Object.entries(TOOL_CONTRACTS.find(t => t.name === name).properties).filter(([, p]) => p.default !== undefined).map(([key, p]) => [key, p.default])), ...args });
export function scoreScripted({ plan, provider, trace, turn, requests, unexpected, client = 'pi', peerRequests = [] }) {
  const check = (id, name, ok, recovery = false) => ({ id, name, ok: Boolean(ok), recovery });
  const checks = [
    check('native-completion', 'Native CLI exits successfully with the scripted completion', turn.exitCode === 0 && !turn.timedOut && !turn.isError && turn.finalText === 'SCRIPTED_MCP_COMPLETE'),
    check('provider-completion', 'Provider script completed without protocol errors', provider.complete && !provider.issues.length && provider.receipts.length === plan.length),
    check('trace-counts', 'Exact call counts and complete MCP trace', !trace.issues.length && trace.calls.length === plan.length && turn.toolCalls.length === plan.length),
    check('backend-requests', 'No unexpected backend requests', unexpected.length === 0),
  ];
  for (const [i, step] of plan.entries()) {
    const native = turn.toolCalls[i]; const mcp = trace.calls[i]; const receipt = provider.receipts[i];
    const mcpText = text(mcp?.result);
    checks.push(check(`round-trip:${i + 1}`, `${i + 1}. ${step.target === 'peer' ? 'Peer ' : ''}${step.name}: provider → native → MCP → native → provider`,
      native?.id === `script-call-${i + 1}` && native.name === scriptedToolName(client, step.name, step.target) && mcp?.name === step.name && receipt?.id === native.id &&
      isDeepStrictEqual(normalizedArgs(step.name, native.input), normalizedArgs(step.name, step.args)) && isDeepStrictEqual(normalizedArgs(step.name, mcp.args), normalizedArgs(step.name, step.args)) &&
      mcpText.includes(step.contains) && scriptedResultText(client, native.result) === mcpText && scriptedResultText(client, receipt.content).includes(mcpText) && mcp.status !== 'pending' && mcp.status !== 'rejected' &&
      (i === 12 ? mcp.result?.isError === true && native.ok === false : (mcp.result?.isError !== true && native.ok === true)), step.recovery));
  }
  const peerIndex = plan.findIndex(step => step.target === 'peer');
  if (peerIndex >= 0) checks.push(check('peer-routing', 'Same-name tools route to distinct MCP processes; peer query never reaches MidBrain',
    trace.calls[peerIndex]?.connection !== trace.calls[0]?.connection && peerRequests.length === 1 &&
    isDeepStrictEqual(peerRequests[0].args, plan[peerIndex].args) && text(peerRequests[0].result) === plan[peerIndex].contains &&
    !requests.some(r => JSON.stringify(r).includes('SCRIPTED_PEER_ONLY'))));
  const has = (method, suffix, test = () => true) => requests.some(r => r.method === method && r.path === `/api/v1${suffix}` && test(r));
  checks.push(check('backend-parameters', 'Backend observed exact search, grep, date, file and account parameters',
    has('GET', '/memories/search/semantic', r => r.query.query === 'DRY_SMOKE_SCRIPTED' && r.query.limit === '9' && r.key === 'global') &&
    has('GET', '/memories/search/lexical', r => r.query.pattern === 'fixture.*' && r.query.limit === '2') &&
    has('GET', '/memories/episodic', r => r.query.start_date === '2026-01-01T00:00:00.000Z' && r.query.end_date === '2026-01-03T00:00:00.000Z') &&
    has('GET', '/memories/semantic/files') && has('GET', '/memories/semantic/files/guide.md', r => r.query.start_line === '2' && r.query.num_lines === '1') &&
    has('GET', '/account/agents', r => r.key === 'user') && has('POST', '/account/agents', r => r.body?.name === 'Dry smoke agent' && r.key === 'user') && has('POST', '/account/keys', r => r.body?.agent_id === 'dry-agent' && r.key === 'user')));
  const failed = trace.calls[12]; const recovered = trace.calls[13];
  checks.push(check('backend-recovery', '503 propagates and a later call succeeds on the same MCP connection',
    has('GET', '/memories/search/semantic', r => r.query.query === 'DRY_SMOKE_UNAVAILABLE' && r.status === 503) &&
    has('GET', '/memories/search/semantic', r => r.query.query === 'DRY_SMOKE_SCRIPTED_RECOVERED' && r.status === 200) &&
    failed && recovered && failed.connection === recovered.connection && failed.completedAt <= recovered.startedAt && recovered.result?.isError !== true, true));
  return checks;
}

// Versioned inventory prevents partial or duplicated green checks from passing.
export function scriptedCheckInventory(client) {
  return [
    ...['install', 'integration', 'candidate', ...(client === 'opencode' ? ['peer-preserved'] : [])].map(id => ({ id, row: 'Installation' })),
    ...['native-completion', 'provider-completion', 'trace-counts', 'backend-requests',
      ...Array.from({ length: client === 'opencode' ? 15 : 14 }, (_, i) => `round-trip:${i + 1}`).filter(id => !['round-trip:13', 'round-trip:14'].includes(id)),
      ...(client === 'opencode' ? ['peer-routing'] : []), 'backend-parameters', 'project-keys', 'candidate-unchanged'].map(id => ({ id, row: 'Native tool round trips' })),
    ...['round-trip:13', 'round-trip:14', 'backend-recovery'].map(id => ({ id, row: 'Failure recovery' })),
  ];
}

export function scriptedOutcome(report) {
  if (!report.run.complete) return 'INCOMPLETE';
  if (!report.isolation.ok || report.cells.some(c => c.status === 'FAIL' || c.checks?.some(ch => !ch.ok))) return 'FAIL';
  if (report.clients.length !== 1 || !SCRIPTED_CLIENTS.includes(report.clients[0].id) || SCRIPTED_ROWS.some(row => !report.cells.some(c => c.client === report.clients[0].id && c.row === row && c.status === 'PASS' && c.checks?.length))) return 'BLOCKED';
  if (report.assertionSchemaVersion !== undefined) {
    if (report.assertionSchemaVersion !== 1 || report.cells.length !== SCRIPTED_ROWS.length) return 'BLOCKED';
    const expected = scriptedCheckInventory(report.clients[0].id);
    const actual = report.cells.flatMap(c => (c.checks || []).map(ch => ({ ...ch, row: c.row })));
    if (actual.length !== expected.length || expected.some(e => {
      const matches = actual.filter(a => a.id === e.id && a.row === e.row);
      return matches.length !== 1 || matches[0].ok !== true;
    })) return 'BLOCKED';
  }
  return 'PASS';
}
