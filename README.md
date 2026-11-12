# Torob Unified MCP + n8n bridge

This integration uses the **API-only** implementation from [siamak/torob-mcp](https://github.com/siamak/torob-mcp), pinned to commit `6951f4261249ee4a2dde6fef893e4dcacb5673e4`. The original repository is built during the Docker image build; its core is not reimplemented here.

The existing `torob/Torob Price Report - Safe Guarded.json` is preserved. This new integration does not replace it.

## Safety changes applied at build time

`patches/apply-safe-policy.mjs` makes the upstream client stop immediately on HTTP 403, 429 and 490, and classify 403/490 or challenge bodies as blocked. HTTP 429 is removed from automatic retry statuses. No CAPTCHA relay, cookie import/replay, browser fingerprint spoofing, proxy rotation, or IP rotation is installed.

## Architecture

- `torob-mcp`: upstream MCP server, Streamable HTTP on the internal Docker network.
- `torob-bridge`: small authenticated REST adapter that is an MCP client. It calls `search_torob`, `product_variants`, `product_details` and every page of `product_sellers`.
- `n8n`: calls the bridge once and converts normalized seller rows into XLSX.

The upstream MCP process owns the shared in-memory LRU cache, token-bucket rate limiter and concurrency semaphore. The bridge serializes export jobs and does not retry blocked/rate-limited MCP calls.

## Start

Requirements: Docker Engine + Docker Compose v2. Create an untracked `.env` beside this compose file:

```dotenv
TOROB_MCP_TOKEN=replace-with-a-random-secret-at-least-32-characters
BRIDGE_PORT=3001
TOROB_MAX_PRODUCTS=25
```

Start:

```bash
cd torob
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:3001/healthz
```

The bridge is published on loopback only. Do not expose it directly to the public internet. Put it behind an authenticated TLS reverse proxy, or attach n8n to the same private Docker network.

## Bridge API

`POST /api/search`

```json
{ "query": "iphone 16", "max_products": 10, "include_variants": true }
```

Send `Authorization: Bearer <TOROB_MCP_TOKEN>`. The response contains `rows`, one row per product-variant/seller offer, and `summary`. The bridge uses a single MCP session per export and follows local cursors until all sellers are collected.

## n8n

Import `../workflows/torob-unified-failover.json`. Configure these environment variables for the n8n process:

- `TOROB_BRIDGE_URL`: full base URL of the bridge, e.g. `http://host.docker.internal:3001` when the host gateway is reachable from n8n, or `http://torob-bridge:3001` on a shared Docker network.
- `TOROB_BRIDGE_TOKEN`: same secret as `TOROB_MCP_TOKEN`.

Activate the workflow and POST JSON to its Webhook URL:

```json
{ "product": "iphone 16", "max_products": 10 }
```

The webhook responds with an XLSX attachment. Prices are numeric Toman values. Store links are blank unless Torob's normalized seller data supplies an explicit URL; the integration does not invent store URLs.

## Failure behavior

- CAPTCHA/challenge or HTTP 403/490: stop immediately; report blocked; human review is required.
- HTTP 429: stop immediately; no automatic retry.
- Timeout, connection failure, invalid JSON/schema: return a typed error; no partial export is marked complete.
- Empty search: return an empty result with an explicit summary.
- A seller page cursor is followed until exhausted; a guard prevents unbounded pagination.

## Validation

Static validation of the generated n8n JSON and code-level tests should be run after deployment. A successful live Torob request is not claimed by repository creation. Live verification requires a running MCP container, a valid secret, network access to Torob, and a manual execution in n8n.
