// Runs in the NanoClaw image. This is a protocol readiness probe, never a
// substitute for real-agent behavioral evidence.
import { readFileSync } from 'node:fs';
import { Client } from '/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '/app/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
const config = JSON.parse(readFileSync('/workspace/agent/container.json', 'utf8')).mcpServers['midbrain-memory'];
const client = new Client({ name: 'midbrain-harness-probe', version: '0.1.0' });
const transport = new StdioClientTransport({ command: config.command, args: config.args, env: { ...process.env, ...config.env }, cwd: '/workspace/agent', stderr: 'pipe' });
transport.stderr?.on('data', chunk => process.stderr.write(chunk));
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(JSON.stringify({ tools: tools.map(t => t.name) }));
} finally { await client.close(); }
