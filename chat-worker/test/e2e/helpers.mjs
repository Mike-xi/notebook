import { deflateSync } from 'node:zlib';

export const BASE = 'http://127.0.0.1:8791';

/* Minimal PNG writer so the suite can upload real images without binary fixtures. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const payload = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, crc]);
}

export function makePng(width, height, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const offset = y * stride;
    for (let x = 0; x < width; x += 1) {
      raw[offset + 1 + x * 3] = (r + x) % 256;
      raw[offset + 2 + x * 3] = (g + y) % 256;
      raw[offset + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function imageFixture(name, size = 260, color = [90, 120, 220]) {
  return { name, mimeType: 'image/png', buffer: makePng(size, Math.round(size * 0.66), color) };
}

export function textFixture(name, body) {
  return { name, mimeType: 'text/plain', buffer: Buffer.from(body, 'utf8') };
}

/* UI helpers ------------------------------------------------------------- */

export async function login(page, account) {
  await page.goto('/');
  await page.locator('#login-form input[name="username"]').fill(account.username);
  await page.locator('#login-form input[name="password"]').fill(account.password);
  await page.locator('#login-form button[type="submit"]').click();
  await page.locator('#app-view').waitFor({ state: 'visible' });
}

export async function openContacts(page) {
  await page.locator('[data-view="contacts"]').click();
}

export async function openChatWith(page, title) {
  await page.locator('[data-view="chats"]').click();
  await page.locator('.chat-item', { hasText: title }).first().click();
  await page.locator('#chat-status.connected').waitFor();
}

export async function sendText(page, text) {
  await page.locator('#message-input').fill(text);
  await page.locator('#message-input').press('Enter');
  try {
    await page.locator('.message-bubble', { hasText: text }).last().waitFor({ timeout: 15000 });
  } catch {
    // A bare "not visible" timeout hides why the send was refused.
    const toast = await page.locator('#toast').textContent();
    const value = await page.locator('#message-input').inputValue();
    const status = await page.locator('#chat-status').textContent();
    throw new Error(`发送「${text}」失败 · toast=${JSON.stringify(toast)} · 输入框=${JSON.stringify(value)} · 状态=${JSON.stringify(status)}`);
  }
}

export function bubbles(page) {
  return page.locator('.message-row');
}
