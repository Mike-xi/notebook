import { readFile } from 'node:fs/promises';

const endpoint = process.env.APPLE_REFRESH_ENDPOINT || 'https://sjtu.ccwu.cc/api/apple/refresh';
const apiKey = process.env.APPLE_REFRESH_KEY || '';
if (!apiKey) throw new Error('缺少 APPLE_REFRESH_KEY');

// 直接复用 Pages Function 中已通过真实页面验证的解析器，避免定时任务与线上规则漂移。
const modulePath = new URL('../review-site/functions/api/apple/refresh.js', import.meta.url);
const source = (await readFile(modulePath, 'utf8')).replace(/^import .*;\r?$/gm, '');
const scraper = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

const collected = await scraper.collectOfficialBatches();
const nestedErrors = collected.batches.flatMap((batch) => batch.errors || []);
if (collected.batches.length !== 5 || collected.errors.length || nestedErrors.length) {
  throw new Error(`Apple 官网采集不完整：${[...collected.errors, ...nestedErrors].join('；') || `${collected.batches.length}/5 分类`}`);
}

const official = collected.batches.map(({ category, rows }) => ({ category, rows }));
const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-API-Key': apiKey,
  },
  body: JSON.stringify({ official }),
});
const text = await response.text();
let report;
try { report = JSON.parse(text); } catch { throw new Error(`刷新端点返回非 JSON（HTTP ${response.status}）`); }
if (!response.ok) throw new Error(`刷新端点失败（HTTP ${response.status}）：${report.error || text.slice(0, 200)}`);

const officialCategories = new Set((report.categories || []).filter((item) => item.source === 'apple-cn').map((item) => item.category));
if (officialCategories.size !== 5) throw new Error(`官网价格写入不完整：${officialCategories.size}/5 分类`);

console.log(JSON.stringify({
  ok: report.ok,
  refreshed_at: report.refreshed_at,
  official_categories: officialCategories.size,
  sources: report.sources,
  changes: report.changes,
  warnings: report.errors,
}, null, 2));
