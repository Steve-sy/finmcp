import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config/index.js';
import { MCPServer } from './index.js';

function parsePort(value: string | undefined, fallback: number): number {
  const n = value ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function main(): Promise<void> {
  // Reuse the existing MCPServer wiring (tools/resources/prompts/middleware).
  const app = new MCPServer();
  await app.initialize();

  // The MCP SDK expects to be connected to a transport. Streamable HTTP runs "per request",
  // but still provides a Transport interface we can connect once and then route HTTP requests to.
  const mcpServer = (app as unknown as { server?: Server }).server;
  if (!mcpServer) {
    throw new Error('Internal error: MCP server not initialized');
  }

  const config = loadConfig();
  const host = process.env.YF_MCP_HOST || '0.0.0.0';
  const port = parsePort(process.env.YF_MCP_PORT || process.env.PORT, 3333);
  const path = process.env.YF_MCP_PATH || '/mcp';

  // Stateless transport keeps things simple for local desktop usage.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });

  await mcpServer.connect(transport);

  const server = http.createServer(async (req, res) => {
    try {
      // Basic routing: only serve MCP on the configured path.
      const url = new URL(req.url || '/', `http://${req.headers.host || host}`);

      // Health check endpoint for Railway / Docker / load balancers.
      if (url.pathname === '/health') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('ok');
        return;
      }

      if (url.pathname !== path) {
        res.statusCode = 404;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end('Not found');
        return;
      }

      // Optional API key auth. Set YF_MCP_API_KEY on the server to enable.
      // Clients pass the key as a query param: /mcp?key=<secret>
      const apiKey = process.env.YF_MCP_API_KEY;
      if (apiKey) {
        const provided = url.searchParams.get('key');
        if (provided !== apiKey) {
          res.statusCode = 401;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end('Unauthorized');
          return;
        }
      }

      // Let the MCP transport handle GET/POST, SSE, etc.
      await transport.handleRequest(req, res);
    } catch (err) {
      // Avoid writing to stdout; MCP JSON-RPC streams are sensitive.
      console.error('HTTP transport error:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
      }
      res.end('Internal server error');
    }
  });

  server.listen(port, host, () => {
    console.error(`FinMCP on Yahoo Finance (streaming HTTP) listening on http://${host}:${port}${path}`);
    console.error(`Config: ${JSON.stringify({ cacheTtlQuotes: config.cache.ttlQuotes }, null, 0)}`);
  });

  const shutdown = async (signal: string) => {
    console.error(`Received ${signal}. Shutting down...`);
    server.close(() => {
      // Intentionally no stdout writes.
      process.exit(0);
    });
    try {
      await app.shutdown();
    } catch (e) {
      console.error('Shutdown error:', e);
    }
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (process.argv[1] && process.argv[1].endsWith('http.js')) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

export { main };
