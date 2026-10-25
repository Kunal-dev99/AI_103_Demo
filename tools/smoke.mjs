// Browser smoke test: serves the site, opens every page, runs every simulator,
// loads every debug scenario, answers the quiz, and fails on console errors or
// horizontal page overflow at phone width.
// Usage: node tools/smoke.mjs [agendaId ...]   (SCREENSHOTS=dir to save screenshots)
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { AGENDA } from '../src/agenda.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = await import('playwright')); }

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  const file = p.endsWith('/') ? path.join(p, 'index.html') : p;
  let body;
  try { body = await readFile(file); } catch { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(body);
}).listen(0);
const base = `http://127.0.0.1:${server.address().port}/index.html`;

const ids = process.argv.slice(2).length ? process.argv.slice(2) : AGENDA.map(a => a.id).filter(id => existsSync(path.join(root, 'content', `${id}.js`)));
const shots = process.env.SCREENSHOTS;
if (shots) await mkdir(shots, { recursive: true });

const browser = await chromium.launch();
const failures = [];
const errors = [];

async function newPage(width) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.on('pageerror', e => errors.push(`${page.url()} pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${page.url()} console: ${m.text()}`); });
  return page;
}

const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

const page = await newPage(1280);
for (const route of ['#/', '#/coverage']) {
  await page.goto(`${base}${route}`);
  await page.waitForSelector('main h1');
  if (route === '#/coverage') await page.waitForFunction(n => document.querySelectorAll('.coverage tbody tr').length >= n, AGENDA.length, { timeout: 30000 }).catch(() => failures.push('coverage table incomplete'));
}

for (const id of ids) {
  const before = errors.length;
  try {
    await page.goto(`${base}#/s/${id}`);
    await page.waitForSelector('.lab .controls', { timeout: 10000 });
    await page.waitForSelector('.workbench', { timeout: 10000 });
    // architecture / code views
    await page.click('details.arch summary');
    for (const v of ['architectural', 'implementation', 'conceptual']) await page.click(`.tab[data-view="${v}"]`);
    await page.click('.viz-actions .btn:first-child'); // expand
    await page.click('.viz-node');
    // run instantly
    await page.selectOption('.lab select[aria-label="Animation speed"]', '0');
    await page.click('.lab .btn.primary');
    await page.waitForSelector('.sim-output .output');
    // step mode
    await page.click('.lab .btn-row .btn:nth-child(2)');
    // samples
    const nSamples = await page.locator('.lab select[aria-label="Load sample input"] option').count();
    for (let i = 0; i < nSamples - 1; i++) await page.selectOption('.lab select[aria-label="Load sample input"]', String(i));
    // debug scenarios
    const nDebug = await page.locator('.debug-card').count();
    for (let i = 0; i < nDebug; i++) {
      await page.locator('.debug-card').nth(i).locator('button', { hasText: 'Load failing scenario' }).click();
      await page.locator('.debug-card').nth(i).locator('.debug-out p').first().waitFor();
    }
    // challenge check + quiz
    await page.click('#sec-assess .btn.primary');
    await page.locator('#sec-assess details summary', { hasText: 'Solution walkthrough' }).click();
    await page.locator('#sec-assess button', { hasText: 'Load the solution settings' }).click();
    await page.waitForTimeout(50);
    await page.selectOption('.lab select[aria-label="Animation speed"]', '0');
    await page.click('.lab .btn.primary');
    await page.click('#sec-assess .btn.primary');
    const ok = await page.locator('#sec-assess .alert.tone-ok').count();
    if (!ok) failures.push(`${id}: solution settings did not pass the challenge in the UI`);
    const nq = await page.locator('.quiz-q').count();
    for (let i = 0; i < nq; i++) await page.locator('.quiz-q').nth(i).locator('.quiz-opt').first().click();
    if (shots) await page.screenshot({ path: path.join(shots, `${id}.png`), fullPage: false });
  } catch (e) {
    failures.push(`${id}: ${e.message.split('\n')[0]}`);
  }
  if (errors.length > before) failures.push(...errors.slice(before).map(e => `${id}: ${e}`));
}

// phone-width overflow check on a sample of pages
const phone = await newPage(390);
for (const route of ['#/', '#/coverage', ...ids.slice(0, 64).map(id => `#/s/${id}`)]) {
  await phone.goto(`${base}${route}`);
  await phone.waitForSelector('main h1');
  if (route.startsWith('#/s/')) { await phone.selectOption('.lab select[aria-label="Animation speed"]', '0'); await phone.click('.lab .btn.primary'); }
  const o = await overflow(phone);
  if (o > 1) failures.push(`${route}: horizontal page overflow of ${o}px at 390px width`);
}

await browser.close();
server.close();
if (failures.length) {
  console.error(`✗ ${failures.length} smoke failure(s):\n` + failures.map(f => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log(`✓ smoke test passed for ${ids.length} lab page(s) plus home and coverage pages.`);
