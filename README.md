# Yahoo Finance MCP Server (Cloud)

Production-grade (Cloud) financial data infrastructure for AI assistants with enterprise-grade resilience, comprehensive data quality validation, and production-ready monitoring.

![FinMCP Demo](https://s13.gifyu.com/images/bmv8P.gif)


### Deploy to the Cloud (Docker-based)

FinMCP ships with a `Dockerfile` and is fully Docker-based, so it runs on any platform that supports containers — Railway, Render, Fly.io, DigitalOcean App Platform, a VPS, or anything else.

**Easiest option — Railway (recommended for beginners):**

1. Sign up at [railway.com](https://railway.com?referralCode=Wvt6V5) *(referral link — gives you free credits)*
2. New Project → **Deploy from GitHub repo** → paste `https://github.com/Steve-sy/finmcp`
3. Railway auto-detects the `Dockerfile` and builds + deploys automatically
4. *(Optional)* Add `YF_MCP_API_KEY` in Railway's **Variables** tab to protect your endpoint
5. Go to **Settings → Networking → Generate Domain** to get your public URL
6. Your MCP endpoint is live at: `https://<your-app>.up.railway.app/mcp`

**Other platforms (Render, Fly.io, VPS, etc.):**

Any platform that can run a Docker container works. Point it at this repo, and set the start command to `node dist/http.js`. The server listens on the `PORT` environment variable (automatically injected by most platforms) and defaults to `3333`.

Optional: protect public deployments with `YF_MCP_API_KEY` and connect using `...?key=YOUR_SECRET`.

### Claude Desktop Integration (Cloud)

Customize -> Connectors -> Add custom connector:
Name: FinMCP
Remote MCP Server URL: your cloud https url: https://<your-domain>/mcp

---

## Local Installation

```bash
npm install -g @mustafa.ramx/finmcp
```

## Quick Start

### Start Server

```bash
finmcp
```

### Claude Desktop Integration (Local — npm)

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "finmcp": {
      "command": "finmcp"
    }
  }
}
```

### Claude Desktop Integration (Local — Docker)

If you prefer Docker over installing Node.js, first build the image:

```bash
docker build -t finmcp .
```

Then add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "finmcp": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "finmcp", "node", "dist/index.js"]
    }
  }
}
```

> **Note:** ChatGPT Desktop MCP support may vary — check its documentation for custom connector configuration.

### Other AI Tools

**Cursor AI / Cline AI:**

```json
{
  "mcpServers": {
    "finmcp": {
      "command": "finmcp"
    }
  }
}
```

## Features

- **15 Financial Data Tools**: Stocks, options, crypto, forex, company intelligence, market sentiment
- **Circuit Breaker Pattern**: Automatic recovery from API failures
- **Multi-Strategy Rate Limiting**: Token bucket + adaptive + per-endpoint limiting
- **Data Quality Scoring**: Completeness and integrity validation
- **Comprehensive Caching**: Graceful fallback with high cache hit ratio (70-90%)
- **Streaming HTTP Transport**: Run locally or deploy to the cloud (Docker/Railway) for HTTPS access
- **Optional API Key Auth**: Protect public deployments with `YF_MCP_API_KEY`
- **Enterprise Testing**: Unit, integration, e2e, and chaos tests

## Available Tools

### Market Data
- `get_quote` - Real-time quotes with quality reporting
- `get_historical_prices` - OHLCV data with date ranges
- `get_historical_prices_multi` - Batch historical data

### Company Intelligence
- `get_quote_summary` - Comprehensive company overview
- `get_balance_sheet` - Assets, liabilities, equity
- `get_income_statement` - Revenue, expenses, net income
- `get_cash_flow_statement` - Operating, investing, financing cash flows
- `get_earnings` - Quarterly earnings with estimates
- `get_analysis` - Analyst recommendations and price targets
- `get_major_holders` - Institutional and insider ownership

### Market Sentiment
- `get_news` - Latest articles with relevance scoring
- `get_options` - Options chains with Greeks
- `get_trending_symbols` - Top movers with volume metrics
- `screener` - Filter stocks by 12+ criteria

### Cross-Asset
- `get_crypto_quote` - Cryptocurrency prices
- `get_forex_quote` - Currency pair exchange rates

## Documentation

For complete documentation including configuration, usage examples, architecture details, and best practices:

**[View Full Documentation on GitHub](https://github.com/Steve-sy/finmcp)**

Documentation includes:
- [Complete Tool Reference](https://github.com/Steve-sy/finmcp/blob/main/docs/TOOLS.md)
- [Usage Guide with Examples](https://github.com/Steve-sy/finmcp/blob/main/docs/USAGE_GUIDE.md)
- [Configuration Guide](https://github.com/Steve-sy/finmcp/blob/main/docs/CONFIGURATION.md)
- [Architecture Details](https://github.com/Steve-sy/finmcp/blob/main/docs/ARCHITECTURE.md)
- [Data Verification Status](https://github.com/Steve-sy/finmcp/blob/main/docs/DATA_VERIFICATION.md)

## Configuration

Create a `config.json` file:

```json
{
  "rateLimit": {
    "requestsPerMinute": 60,
    "requestsPerHour": 1500
  },
  "cache": {
    "ttlQuotes": 60000,
    "maxCacheSize": 1000
  },
  "circuitBreaker": {
    "failureThreshold": 5,
    "monitoringWindow": 60000,
    "successThreshold": 3
  }
}
```

For detailed configuration options, see [Configuration Guide](https://github.com/Steve-sy/finmcp/blob/main/docs/CONFIGURATION.md).

## Performance

| Metric | Value |
|--------|-------|
| Quote queries | 60 requests/minute (configurable) |
| Batch operations | Up to 100 symbols per request |
| Cache hit ratio | 70-90% for frequently accessed symbols |
| Cold start time | <500ms |
| Test coverage | 95%+ for core middleware |

## License

MIT

## Links

- [GitHub Repository](https://github.com/Steve-sy/finmcp)
- [npm Package](https://www.npmjs.com/package/@mustafa.ramx/finmcp)
- [MCP Protocol](https://modelcontextprotocol.io/)
- [Report Issues](https://github.com/Steve-sy/finmcp/issues)
