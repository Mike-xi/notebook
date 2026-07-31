/* Manual walkthrough: drives the UI and drops screenshots for eyeballing.
   Run with:  node test/e2e/tour.mjs [outDir]                              */
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { BASE, imageFixture, textFixture, login, openChatWith } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const accounts = JSON.parse(readFileSync(path.join(here, '.accounts.json'), 'utf8'));
const outDir = process.argv[2] || path.join(here, 'shots');
mkdirSync(outDir, { recursive: true });

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log('shot:', name);
};

const browser = await chromium.launch();

async function openDesktop(colorScheme) {
  const context = await browser.newContext({ baseURL: BASE, viewport: { width: 1440, height: 900 }, colorScheme });
  const page = await context.newPage();
  page.on('dialog', (dialog) => dialog.accept('演示群组'));
  await login(page, accounts.alice);
  return { context, page };
}

const { context, page } = await openDesktop('light');

// A DM with a mix of content so the bubbles have something to show.
await openChatWith(page, accounts.bob.displayName);

await page.locator('#message-input').fill('这周的封面图，看看哪张好 🙂');
await page.locator('#message-input').press('Enter');
await page.locator('#file-input').setInputFiles([
  imageFixture('cover-a.png', 320, [80, 100, 210]),
  imageFixture('cover-b.png', 260, [210, 120, 90]),
]);
await page.waitForTimeout(150);
await shot(page, '01-attachment-tray');

await page.locator('.send-button').click();
await page.waitForTimeout(400);
await page.locator('#file-input').setInputFiles([textFixture('会议纪要.txt', '星邮附件演示')]);
await page.locator('.send-button').click();
await page.waitForTimeout(300);
await page.locator('#message-input').fill('🎉');
await page.locator('#message-input').press('Enter');
await page.waitForTimeout(300);
await shot(page, '02-conversation');

await page.locator('#emoji-button').click();
await page.waitForTimeout(150);
await shot(page, '03-emoji-panel');
await page.keyboard.press('Escape');

await page.locator('#attach-button').click();
await page.waitForTimeout(150);
await shot(page, '04-attach-menu');
await page.keyboard.press('Escape');

const target = page.locator('.message-row', { hasText: '这周的封面图' }).first();
await target.hover();
await target.locator('[data-reply-message]').click();
await page.locator('#message-input').fill('我选第一张');
await page.waitForTimeout(120);
await shot(page, '05-reply-context');
await page.locator('#message-input').press('Enter');
await page.waitForTimeout(300);

await page.locator('.message-attachment.media').first().click();
await page.waitForTimeout(350);
await shot(page, '06-lightbox');
await page.locator('#lightbox-zoom-in').click();
await page.locator('#lightbox-zoom-in').click();
await page.waitForTimeout(250);
await shot(page, '07-lightbox-zoomed');
await page.keyboard.press('Escape');

await page.locator('#chat-details-button').click();
await page.waitForTimeout(250);
await shot(page, '08-detail-panel');
await page.locator('#detail-close').click();
await context.close();

// Dark mode + mobile layout
const dark = await openDesktop('dark');
await openChatWith(dark.page, accounts.bob.displayName);
await dark.page.waitForTimeout(500);
await shot(dark.page, '09-dark');
await dark.page.locator('.message-attachment.media').first().click();
await dark.page.waitForTimeout(350);
await shot(dark.page, '10-dark-lightbox');
await dark.context.close();

const mobileContext = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const mobile = await mobileContext.newPage();
await login(mobile, accounts.alice);
await openChatWith(mobile, accounts.bob.displayName);
await mobile.waitForTimeout(400);
await shot(mobile, '11-mobile');
await mobile.locator('#emoji-button').click();
await mobile.waitForTimeout(200);
await shot(mobile, '12-mobile-emoji');
await mobileContext.close();

await browser.close();
console.log('done →', outDir);
