import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'Addition MSC Server',
  version: '0.0.1',
});

server.registerTool(
  'add',
  {
    title: 'Addition Tool',
    description: 'Add two numbers',
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => {
    const sum = a + b;
    return { content: [{ type: 'text', text: JSON.stringify(sum) }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
