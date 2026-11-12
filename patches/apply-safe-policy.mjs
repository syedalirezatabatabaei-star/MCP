import fs from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('Usage: node apply-safe-policy.mjs <upstream-client.ts>');
let source = fs.readFileSync(file, 'utf8');

const oldRetry = 'const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);';
const newRetry = 'const RETRYABLE_STATUS: ReadonlySet<number> = new Set([500, 502, 503, 504]);';
if (source.includes(oldRetry)) {
  source = source.replace(oldRetry, newRetry);
} else if (!source.includes(newRetry)) {
  throw new Error('Safe policy patch failed: retry status declaration was not found');
}

const marker = '  if (looksLikeHtml) {';
const policy = `  // Unified integration policy: challenge and access-limit responses are terminal.
  // Never retry 403/429/490 and never replay cookies or browser challenge tokens.
  if ([403, 429, 490].includes(status) && /captcha|cloudflare|cf-chl|challenge|robot/i.test(text)) {
    return new TorobError('Blocked', {
      hint: 'Torob returned an anti-bot challenge or access restriction - requests have stopped; human review is required',
      status,
      endpoint,
      detail: 'challenge signature in upstream response',
    });
  }

  if (status === 403 || status === 490) {
    return new TorobError('Blocked', {
      hint: 'Torob returned HTTP ' + status + ' - requests have stopped; human review is required',
      status,
      endpoint,
      detail: 'terminal access restriction',
    });
  }

`;
if (!source.includes(policy.trim())) {
  const at = source.indexOf(marker);
  if (at < 0) throw new Error('Safe policy patch failed: classify marker was not found');
  source = source.slice(0, at) + policy + source.slice(at);
}

fs.writeFileSync(file, source);
console.log('Applied safe Torob policy: 403/490 blocked, 429 terminal, no automatic retry.');
