import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { diagnoseTorobBlock } from './ai-diagnose.mjs';

const HOST = process.env.HOST ?? '0.0.0.0';
const PORT = Number(process.env.PORT ?? 3001);
const MCP_URL = process.env.TOROB_MCP_URL ?? 'http://torob-mcp:3000';
const TOKEN = process.env.TOROB_MCP_TOKEN ?? '';
const MAX_PRODUCTS = Math.min(50, Math.max(1, Number(process.env.MAX_PRODUCTS ?? 25)));
const CALL_GAP = Math.max(0, Number(process.env.MCP_CALL_GAP_MS ?? 550));
const BODY_LIMIT = 32 * 1024;

if (TOKEN.length < 16) throw new Error('TOROB_MCP_TOKEN must contain at least 16 characters');
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Invalid PORT');

let busy = false;
let lastCallAt = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pace = async () => {
  const wait = Math.max(0, CALL_GAP - (Date.now() - lastCallAt));
  if (wait) await sleep(wait);
  lastCallAt = Date.now();
};

function authorized(req) {
  const value = req.headers.authorization ?? '';
  const provided = value.startsWith('Bearer ') ? Buffer.from(value.slice(7)) : Buffer.alloc(0);
  const expected = Buffer.from(TOKEN);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
}

function toolText(result) {
  const text = (result?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  if (result?.isError) {
    const kind = /^(Blocked|RateLimited|Timeout|SchemaDrift|NotFound|Upstream):/i.exec(text)?.[1] ?? 'Upstream';
    const error = new Error(text || 'MCP tool returned an error');
    error.kind = kind;
    throw error;
  }
  if (!text) throw Object.assign(new Error('MCP tool returned an empty response'), { kind: 'SchemaDrift' });
  try { return JSON.parse(text); }
  catch { throw Object.assign(new Error('MCP tool returned invalid JSON'), { kind: 'SchemaDrift' }); }
}

async function call(client, name, args) {
  await pace();
  const result = await client.callTool({ name, arguments: args });
  return toolText(result);
}

function statusFor(error) {
  if (error.kind === 'Blocked') return 423;
  if (error.kind === 'RateLimited') return 429;
  if (error.kind === 'Timeout') return 504;
  if (error.kind === 'SchemaDrift') return 502;
  if (error.kind === 'NotFound') return 404;
  return 502;
}

function firstDefined(object, names) {
  for (const name of names) {
    const value = object?.[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
}

function specValue(details, expression) {
  const entries = { ...(details?.key_specs ?? {}), ...(details?.specs ?? {}) };
  for (const [key, value] of Object.entries(entries)) {
    if (expression.test(key)) return value;
  }
  return null;
}

async function collectSearch(client, query, maxProducts, includeVariants) {
  const products = [];
  const seen = new Set();
  let cursor;
  let searchPages = 0;
  do {
    const args = { query, limit: 50, sort: 'most_sellers', ...(cursor ? { cursor } : {}) };
    const page = await call(client, 'search_torob', args);
    if (!page || !Array.isArray(page.products)) {
      throw Object.assign(new Error('search_torob returned an unexpected response shape'), { kind: 'SchemaDrift' });
    }
    searchPages += 1;
    for (const product of page.products) {
      const id = String(product.product_id ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      products.push(product);
      if (products.length >= maxProducts) break;
    }
    cursor = products.length >= maxProducts ? undefined : page.next_cursor;
  } while (cursor && searchPages < 20);
  return { products, searchPages, includeVariants };
}

async function collectVariantIds(client, product, includeVariants) {
  const variants = new Map();
  variants.set(product.product_id, { product_id: product.product_id, title: product.title_fa ?? product.title_en ?? '', group: '' });
  if (!includeVariants) return [...variants.values()];
  const result = await call(client, 'product_variants', { product_id: product.product_id });
  if (!result || !Array.isArray(result.groups)) {
    throw Object.assign(new Error('product_variants returned an unexpected response shape'), { kind: 'SchemaDrift' });
  }
  for (const group of result.groups) {
    for (const variant of group.variants ?? []) {
      if (!variant.product_id) continue;
      variants.set(variant.product_id, {
        product_id: variant.product_id,
        title: variant.title ?? '',
        group: group.title ?? ''
      });
    }
  }
  return [...variants.values()];
}

async function collectSellerPages(client, productId) {
  const sellers = [];
  const seenCursors = new Set();
  let cursor;
  let pages = 0;
  do {
    const args = { product_id: productId, sort: 'cheapest', limit: 50, ...(cursor ? { cursor } : {}) };
    const page = await call(client, 'product_sellers', args);
    if (!page || !Array.isArray(page.sellers)) {
      throw Object.assign(new Error('product_sellers returned an unexpected response shape'), { kind: 'SchemaDrift' });
    }
    sellers.push(...page.sellers);
    pages += 1;
    cursor = page.next_cursor;
    if (cursor && seenCursors.has(cursor)) {
      throw Object.assign(new Error('Seller pagination cursor repeated; refusing an infinite loop'), { kind: 'SchemaDrift' });
    }
    if (cursor) seenCursors.add(cursor);
    if (pages > 200) throw Object.assign(new Error('Seller pagination exceeded the safety ceiling'), { kind: 'SchemaDrift' });
  } while (cursor);
  return { sellers, pages };
}

async function runExport(input) {
  const query = String(input.query ?? '').trim();
  if (!query) throw Object.assign(new Error('query is required'), { status: 400 });
  const requested = Number(input.max_products ?? 10);
  if (!Number.isInteger(requested) || requested < 1 || requested > MAX_PRODUCTS) {
    throw Object.assign(new Error(`max_products must be between 1 and ${MAX_PRODUCTS}`), { status: 400 });
  }
  const includeVariants = input.include_variants !== false;
  const client = new Client({ name: 'torob-n8n-bridge', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${MCP_URL.replace(/\/$/, '')}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } }
  });
  const rows = [];
  const issues = [];
  const retrievedAt = new Date().toISOString();
  let searchPages = 0;
  let variantCount = 0;
  let sellerPages = 0;
  let sellerCount = 0;

  try {
    await client.connect(transport);
    const found = await collectSearch(client, query, requested, includeVariants);
    searchPages = found.searchPages;
    for (const product of found.products) {
      const variants = await collectVariantIds(client, product, includeVariants);
      variantCount += variants.length;
      for (const variant of variants) {
        const details = await call(client, 'product_details', { product_id: variant.product_id });
        const sellersResult = await collectSellerPages(client, variant.product_id);
        sellerPages += sellersResult.pages;
        sellerCount += sellersResult.sellers.length;
        const title = firstDefined(details, ['title_fa', 'title_en']) ?? variant.title ?? product.title_fa ?? '';
        const titleEn = firstDefined(details, ['title_en']) ?? product.title_en ?? '';
        const brand = specValue(details, /برند|brand/i);
        const model = specValue(details, /مدل|model/i);
        const capacity = specValue(details, /حافظه|ظرفیت|storage|capacity/i);
        const color = specValue(details, /رنگ|color/i);
        const productUrl = details.url ?? product.url ?? '';
        if (sellersResult.sellers.length === 0) {
          rows.push({
            'نام محصول': title,
            'برند': brand,
            'مدل': model,
            'شناسه محصول ترب': variant.product_id,
            'نام فروشگاه': '',
            'قیمت': null,
            'لینک محصول': productUrl,
            'لینک فروشگاه': '',
            'وضعیت موجودی': 'فروشنده‌ای گزارش نشد',
            'تاریخ و زمان دریافت اطلاعات': retrievedAt,
            'نوع داده': 'محصول بدون پیشنهاد فروشنده',
            'عنوان انگلیسی': titleEn,
            'ظرفیت': capacity ?? variant.group,
            'رنگ': color,
            'عنوان تنوع': variant.title,
            'شهر فروشگاه': '',
            'امتیاز فروشگاه': null,
            'قیمت نامعتبر از نظر ترب': null,
            'شناسه فروشگاه': null
          });
        }
        for (const seller of sellersResult.sellers) {
          rows.push({
            'نام محصول': title,
            'برند': brand,
            'مدل': model,
            'شناسه محصول ترب': variant.product_id,
            'نام فروشگاه': seller.shop_name ?? '',
            'قیمت': seller.price_toman ?? null,
            'لینک محصول': productUrl,
            'لینک فروشگاه': seller.shop_url ?? seller.url ?? '',
            'وضعیت موجودی': seller.in_stock === true ? 'موجود' : seller.in_stock === false ? 'ناموجود' : 'نامشخص',
            'تاریخ و زمان دریافت اطلاعات': retrievedAt,
            'نوع داده': 'پیشنهاد فروشنده آنلاین',
            'عنوان انگلیسی': titleEn,
            'ظرفیت': capacity ?? variant.group,
            'رنگ': color,
            'عنوان تنوع': variant.title,
            'شهر فروشگاه': seller.shop_city ?? '',
            'امتیاز فروشگاه': seller.trust?.score ?? null,
            'قیمت نامعتبر از نظر ترب': seller.price_unreliable === true ? 'بله' : 'خیر',
            'شناسه فروشگاه': seller.shop_id ?? null
          });
        }
      }
    }
    return {
      ok: true,
      query,
      retrieved_at: retrievedAt,
      summary: {
        products_found: found.products.length,
        variants_processed: variantCount,
        seller_offers: sellerCount,
        search_pages: searchPages,
        seller_pages: sellerPages,
        rows: rows.length,
        complete: true
      },
      issues,
      rows
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/healthz') {
    send(res, 200, { status: 'ok', mcp_url: MCP_URL });
    return;
  }
  if (!authorized(req)) {
    send(res, 401, { ok: false, error: 'unauthorized' });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/diagnose') {
    try {
      const input = await readJson(req);
      const result = await diagnoseTorobBlock(input);
      send(res, 200, result);
    } catch (error) {
      send(res, 502, { enabled: true, status: 'diagnostic_error', message: error.message });
    }
    return;
  }
  if (req.method !== 'POST' || url.pathname !== '/api/search') {
    send(res, 404, { ok: false, error: 'not found' });
    return;
  }
  if (busy) {
    send(res, 429, { ok: false, error: 'another export is running; try later', code: 'BRIDGE_BUSY' });
    return;
  }
  busy = true;
  try {
    const input = await readJson(req);
    const result = await runExport(input);
    send(res, 200, result);
  } catch (error) {
    const status = error.status ?? statusFor(error);
    const blocked = error.kind === 'Blocked' || status === 423;
    const response = {
      ok: false,
      code: error.kind ?? 'REQUEST_FAILED',
      error: error.message ?? 'Torob export failed',
      human_review_required: blocked,
      retry_automatically: false
    };
    if (blocked) {
      response.ai_diagnosis = await diagnoseTorobBlock({ code: response.code, error: response.error });
    }
    send(res, status, response);
  } finally {
    busy = false;
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`torob bridge listening on ${HOST}:${PORT}\n`);
});
