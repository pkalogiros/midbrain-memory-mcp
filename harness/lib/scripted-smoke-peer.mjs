// A second, independent MCP server deliberately reuses a MidBrain tool name.
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
const server = new McpServer({ name: 'scripted-peer', version: '1.0.0' });
server.tool('memory_search', 'Independent coexistence fixture; never calls MidBrain', { query: z.string() }, async args => {
  const result = { content: [{ type: 'text', text: 'SCRIPTED_PEER_RESPONSE' }] };
  appendFileSync(process.argv[2], `${JSON.stringify({ args, result })}\n`, { mode: 0o600 });
  return result;
});
await server.connect(new StdioServerTransport());
