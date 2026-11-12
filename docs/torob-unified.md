# Torob unified integration - implementation notes

## Repository inspection

The target repository's `main` tree contained `torob/Torob Price Report - Safe Guarded.json`, not the exact path `torob/Torob Price Report.json` requested in the brief. The existing Safe Guarded workflow is retained unchanged. It contains direct Torob HTTP calls, seller/map requests, response guards and XLSX output; it is not silently overwritten or treated as the MCP-based final workflow.

### Source projects

- `MasterLegoYoda/turub`: TypeScript, Node 20+, MCP SDK 1.29, Express 5 and Zod 3. The API adapter fans out to Torob endpoints and normalizes products, sellers and price history. The repository also contains CloakBrowser/fingerprint/cookie handling and CAPTCHA cookie relay code. Those anti-detection and cookie-replay paths are excluded from this integration.
- `siamak/torob-mcp`: TypeScript monorepo, Node 22+, pnpm 10.19, MCP SDK 1.30.1, Zod 4, LRU cache, token-bucket rate limiting and a concurrency semaphore. The Node runtime provides Streamable HTTP at `/mcp`, bearer-token authentication on non-loopback binds, bounded request bodies, session limits and a health endpoint.

The selected upstream commit is `6951f4261249ee4a2dde6fef893e4dcacb5673e4` (main at inspection time). The MCP core has tools for search, product details, seller offers, variants, price chart/history, similar products, filters, shop profile and batch operations. The sellers endpoint is fetched once and paginated locally by opaque cursor, so seller pagination does not issue one upstream request per page.

## Why Siamak is the runtime base

Its endpoint allowlist, Zod response schemas, size-capped reads, redirects restricted to Torob hosts, cache, conservative token bucket, concurrency limit and normalized seller objects make it the safer base. Turub's broader data-source abstraction and price-history normalization informed the comparison, but its browser cloak, fingerprint pool, cookie jar and CAPTCHA relay are not used.

## Error policy overlay

The pinned upstream client retries selected transient 5xx responses. The build overlay removes 429 from retryable statuses and makes 403/490 terminal blocked responses. Challenge signatures in 403/429/490 bodies are also terminal. A blocked result is surfaced for human review; no CAPTCHA bypass, cookie reuse, fingerprint spoofing, proxy rotation or IP rotation is implemented.

## Data and limitations

Each Excel row represents one seller offer for one Torob product variant. Variants receive their own product IDs and seller queries. Price is numeric Toman. Inventory remains tri-state (available, unavailable, unknown). The timestamp is the bridge's retrieval time, not Torob's last-price-change time.

The normalized seller object currently exposes shop ID/name/city/trust and price/inventory data, but does not guarantee an explicit shop URL. The export therefore leaves the store URL blank unless a URL is actually returned; it never guesses one. Brand/model/capacity/color are extracted from returned key/full specs when present and otherwise left blank. Variant title and variant group are retained to prevent silently merging colors/capacities.

The API is unofficial and undocumented. Endpoint stability, completeness and access are not guaranteed by Torob. A reported seller count may differ from actual returned offers; the integration records actual rows received and does not claim more.

## n8n setup

Import `workflows/torob-unified-failover.json`. Set `TOROB_BRIDGE_URL` and `TOROB_BRIDGE_TOKEN` in the n8n process environment. Configure the bridge URL so it is reachable over a private network. The workflow's webhook accepts `product` (or `query`) and optional `max_products` (default 10; maximum configured by bridge, default 25).

## Verification status

The JSON and source files are stored as source artifacts. Repository writes do not execute Docker, connect to Torob, or run an n8n instance. Do not interpret repository creation as a live Torob test. After deployment, run `docker compose up -d --build`, check both health endpoints, then execute the n8n webhook with a low-volume query. A live result is successful only if the upstream request actually completes and the XLSX attachment opens correctly.
