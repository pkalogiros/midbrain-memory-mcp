// Minimal local provider protocols. These encode predetermined responses only;
// no SDK, credentials or external inference endpoint is involved.
import { TOOL_CONTRACTS, checkToolSchema, checkSchemaContract } from './tool-contracts.mjs';

export function checkProviderToolSchema(client, name, schema) {
  if (client !== 'codex') return checkToolSchema(name, schema);
  const expected = TOOL_CONTRACTS.find(t => t.name === name);
  if (!expected) return [`Unknown tool ${name}`];
  // Codex projects MCP schemas into its function schema subset. Raw MCP
  // constraints are checked separately; do not pretend the provider saw them.
  const properties = Object.fromEntries(Object.entries(expected.properties).map(([key, fields]) => [key, Object.fromEntries(Object.entries(fields).filter(([field]) => !['minimum', 'maximum', 'default'].includes(field)))]));
  return checkSchemaContract({ ...expected, properties }, schema);
}

const qualifiedName = item => item.namespace ? `${item.namespace}__${item.name}` : item.name;
const contentText = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(v => v.text || '').join('\n') : JSON.stringify(value);
export function scriptedEndpoint(client) { return client === 'claude' ? '/v1/messages' : client === 'codex' ? '/v1/responses' : '/v1/chat/completions'; }
export function normalizeScriptedRequest(client, body) {
  if (client === 'claude') {
    if (!Array.isArray(body.messages)) throw new Error('Missing Messages conversation');
    return { tools: (body.tools || []).map(t => ({ name: t.name, schema: t.input_schema })),
      calls: body.messages.flatMap(m => m.role === 'assistant' && Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input })) : []),
      results: body.messages.flatMap(m => m.role === 'user' && Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_result').map(b => ({ id: b.tool_use_id, content: contentText(b.content), isError: b.is_error === true })) : []) };
  }
  if (client === 'codex') {
    if (!Array.isArray(body.input)) throw new Error('Missing Responses input');
    return { tools: (body.tools || []).flatMap(t => t.type === 'namespace' ? (t.tools || []).map(f => ({ name: `${t.name}__${f.name}`, schema: f.parameters })) : [{ name: t.name, schema: t.parameters }]),
      calls: body.input.filter(i => i.type === 'function_call').map(i => ({ id: i.call_id, name: qualifiedName(i), args: JSON.parse(i.arguments) })),
      results: body.input.filter(i => i.type === 'function_call_output').map(i => ({ id: i.call_id, content: contentText(i.output) })) };
  }
  if (!Array.isArray(body.messages)) throw new Error('Missing Chat Completions conversation');
  return { tools: (body.tools || []).map(t => ({ name: t.function?.name, schema: t.function?.parameters })),
    calls: body.messages.flatMap(m => m.role === 'assistant' ? (m.tool_calls || []).map(c => ({ id: c.id, name: c.function?.name, args: JSON.parse(c.function.arguments) })) : []),
    results: body.messages.filter(m => m.role === 'tool').map(m => ({ id: m.tool_call_id, content: contentText(m.content) })) };
}
export function sendScriptedResponse(client, res, body, call, index) {
  const text = 'SCRIPTED_MCP_COMPLETE';
  const json = value => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const start = () => res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  if (client === 'claude') {
    const block = call ? { type: 'tool_use', id: call.id, name: call.name, input: call.args } : { type: 'text', text };
    const message = { id: `msg_script_${index}`, type: 'message', role: 'assistant', model: 'mcp-script', content: [block], stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
    if (!body.stream) return json(message);
    start(); event('message_start', { message: { ...message, content: [], stop_reason: null } });
    event('content_block_start', { index: 0, content_block: call ? { ...block, input: {} } : { type: 'text', text: '' } });
    event('content_block_delta', { index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify(call.args) } : { type: 'text_delta', text } });
    event('content_block_stop', { index: 0 });
    event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 0 } });
    event('message_stop', {}); res.end(); return;
  }
  if (client === 'codex') {
    const separator = call?.name.lastIndexOf('__') ?? -1;
    const identity = separator < 0 ? { name: call?.name } : { namespace: call.name.slice(0, separator), name: call.name.slice(separator + 2) };
    const item = call ? { type: 'function_call', id: `fc_script_${index}`, call_id: call.id, ...identity, arguments: JSON.stringify(call.args), status: 'completed' }
      : { type: 'message', id: `msg_script_${index}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    const response = { id: `resp_script_${index}`, object: 'response', created_at: Math.floor(Date.now() / 1000), model: 'mcp-script', status: 'completed', output: [item], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } };
    if (!body.stream) return json(response);
    start(); let sequence = 0; const emit = (type, data) => event(type, { sequence_number: sequence++, ...data });
    emit('response.created', { response: { ...response, status: 'in_progress', output: [] } });
    emit('response.output_item.added', { output_index: 0, item: call ? { ...item, arguments: '', status: 'in_progress' } : { ...item, content: [], status: 'in_progress' } });
    if (call) {
      emit('response.function_call_arguments.delta', { item_id: item.id, output_index: 0, delta: item.arguments });
      emit('response.function_call_arguments.done', { item_id: item.id, output_index: 0, arguments: item.arguments });
    } else {
      emit('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
      emit('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: text });
      emit('response.output_text.done', { item_id: item.id, output_index: 0, content_index: 0, text });
      emit('response.content_part.done', { item_id: item.id, output_index: 0, content_index: 0, part: item.content[0] });
    }
    emit('response.output_item.done', { output_index: 0, item }); emit('response.completed', { response }); res.end(); return;
  }
  const tools = call ? [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] : null;
  const message = tools ? { role: 'assistant', content: null, tool_calls: tools } : { role: 'assistant', content: text };
  const finish = tools ? 'tool_calls' : 'stop';
  const common = { id: `script-response-${index}`, created: Math.floor(Date.now() / 1000), model: 'mcp-script' };
  if (!body.stream) return json({ ...common, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }] });
  start(); const delta = tools ? { role: 'assistant', tool_calls: tools.map((c, index) => ({ index, ...c })) } : message;
  for (const choice of [{ index: 0, delta, finish_reason: null }, { index: 0, delta: {}, finish_reason: finish }]) res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [choice] })}\n\n`);
  res.end('data: [DONE]\n\n');
}
