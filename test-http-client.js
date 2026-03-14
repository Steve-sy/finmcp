import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function main() {
  const url = process.env.MCP_URL || 'http://127.0.0.1:3333/mcp';

  const client = new Client(
    { name: 'finmcp-http-test', version: '1.0.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } }
  );

  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);

  const tools = await client.listTools();
  console.log(`tools: ${tools.tools.length}`);
  for (const t of tools.tools.slice(0, 10)) {
    console.log(`- ${t.name}`);
  }

  // Optional: try a simple call if the server supports it.
  if (tools.tools.some((t) => t.name === 'get_quote')) {
    const result = await client.callTool({
      name: 'get_quote',
      arguments: { symbols: ['AAPL'] }
    });
    console.log('get_quote ok');
    console.log(JSON.stringify(result, null, 2));
  }

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

