import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { login, openContacts, sendText, imageFixture, textFixture } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const accounts = JSON.parse(readFileSync(path.join(here, '.accounts.json'), 'utf8'));

test.describe.serial('星邮 Starpost', () => {
  let aliceContext;
  let bobContext;
  let alice;
  let bob;
  let promptAnswer = '';

  function wireDialogs(page) {
    page.on('dialog', async (dialog) => {
      if (dialog.type() === 'prompt') await dialog.accept(promptAnswer);
      else await dialog.accept();
    });
  }

  test.beforeAll(async ({ browser }) => {
    aliceContext = await browser.newContext();
    bobContext = await browser.newContext();
    alice = await aliceContext.newPage();
    bob = await bobContext.newPage();
    wireDialogs(alice);
    wireDialogs(bob);
    await login(alice, accounts.alice);
    await login(bob, accounts.bob);
  });

  test.afterAll(async () => {
    await aliceContext.close();
    await bobContext.close();
  });

  test('发送并接受好友申请', async () => {
    await openContacts(alice);
    await alice.locator('#sidebar-search').fill(accounts.bob.username);
    await alice.locator(`[data-add-user="${accounts.bob.username}"]`).click();
    await expect(alice.locator('#toast')).toContainText('好友申请已发送');

    await bob.reload();
    await bob.locator('#app-view').waitFor({ state: 'visible' });
    await openContacts(bob);
    await expect(bob.locator('.section-caption', { hasText: '好友申请' })).toBeVisible();
    await bob.locator('[data-friend-action="accept"]').first().click();
    await expect(bob.locator('#toast')).toContainText('已成为好友');
  });

  test('私聊实时送达，纯表情消息放大显示', async () => {
    await alice.reload();
    await alice.locator('#app-view').waitFor({ state: 'visible' });
    await openContacts(alice);
    await alice.locator(`[data-dm-user="${accounts.bob.id}"]`).click();
    await alice.locator('#chat-status.connected').waitFor();
    await sendText(alice, '你好，鲍勃');

    await openContacts(bob);
    await bob.locator(`[data-dm-user="${accounts.alice.id}"]`).click();
    await bob.locator('#chat-status.connected').waitFor();
    await expect(bob.locator('.message-bubble', { hasText: '你好，鲍勃' })).toBeVisible();

    // Emoji picker inserts at the caret; an emoji-only message renders jumbo.
    await bob.locator('#emoji-button').click();
    await expect(bob.locator('#emoji-panel')).toBeVisible();
    await bob.locator('#emoji-grid button').first().click();
    await expect(bob.locator('#message-input')).not.toHaveValue('');
    await bob.locator('#message-input').press('Enter');

    await expect(alice.locator('.message-text.jumbo')).toBeVisible();
  });

  test('刚点开会话立刻发送不会被连接状态挡住，也不会给自己挂未读', async () => {
    await alice.reload();
    await alice.locator('#app-view').waitFor({ state: 'visible' });
    await alice.locator('[data-view="chats"]').click();
    await alice.locator('.chat-item', { hasText: accounts.bob.displayName }).first().click();

    // No waiting for the socket on purpose: the composer must hold the message
    // until the handshake finishes instead of rejecting it.
    await alice.locator('#message-input').fill('抢跑发送');
    await alice.locator('#message-input').press('Enter');
    await expect(alice.locator('.message-bubble', { hasText: '抢跑发送' })).toBeVisible();
    await expect(alice.locator('#toast')).toBeHidden();
    await expect(alice.locator('.chat-item.active .unread-badge')).toHaveCount(0);
  });

  test('图片消息可放大预览、翻页与缩放', async () => {
    await alice.locator('#file-input').setInputFiles([
      imageFixture('shot-one.png', 280, [70, 110, 220]),
      imageFixture('shot-two.png', 240, [200, 90, 120]),
    ]);
    await expect(alice.locator('.tray-item')).toHaveCount(2);
    await alice.locator('#message-input').fill('两张图');
    await alice.locator('.send-button').click();
    await expect(alice.locator('.message-attachment.media img')).toHaveCount(2);
    await expect(alice.locator('#attachment-tray')).toBeHidden();

    // The bubble must not blow up to the raw image size.
    const box = await alice.locator('.message-attachment.media img').first().boundingBox();
    expect(box.width).toBeLessThanOrEqual(300);

    await alice.locator('.message-attachment.media').first().click();
    await expect(alice.locator('#lightbox')).toBeVisible();
    await expect(alice.locator('#lightbox-scale')).toHaveText('100%');
    await expect(alice.locator('#lightbox-strip button')).toHaveCount(2);

    await alice.locator('#lightbox-zoom-in').click();
    await expect(alice.locator('#lightbox-scale')).not.toHaveText('100%');
    await alice.locator('#lightbox-reset').click();
    await expect(alice.locator('#lightbox-scale')).toHaveText('100%');

    await alice.locator('#lightbox-next').click();
    await expect(alice.locator('#lightbox-meta')).toContainText('2 / 2');
    await alice.keyboard.press('ArrowLeft');
    await expect(alice.locator('#lightbox-meta')).toContainText('1 / 2');

    await alice.keyboard.press('Escape');
    await expect(alice.locator('#lightbox')).toBeHidden();
  });

  test('混合类型附件排队发送', async () => {
    await alice.locator('#file-input').setInputFiles([
      textFixture('notes.txt', '星邮附件测试'),
      imageFixture('third.png', 200, [120, 200, 140]),
    ]);
    await expect(alice.locator('.tray-item')).toHaveCount(2);
    await alice.locator('.tray-item button').first().click();
    await expect(alice.locator('.tray-item')).toHaveCount(1);

    await alice.locator('#file-input').setInputFiles([textFixture('readme.txt', '再来一个')]);
    await expect(alice.locator('.tray-item')).toHaveCount(2);
    await alice.locator('.send-button').click();
    await expect(alice.locator('.file-card', { hasText: 'readme.txt' })).toBeVisible();
    await expect(alice.locator('.message-attachment.media img')).toHaveCount(3);
  });

  test('引用回复可跳回原消息', async () => {
    const target = alice.locator('.message-row', { hasText: '你好，鲍勃' }).first();
    await target.hover();
    await target.locator('[data-reply-message]').click();
    await expect(alice.locator('#composer-context')).toBeVisible();
    await expect(alice.locator('#context-title')).toContainText('回复');

    await sendText(alice, '这是引用回复');
    await expect(alice.locator('.message-quote').last()).toContainText('你好，鲍勃');
    await expect(alice.locator('#composer-context')).toBeHidden();

    await expect(bob.locator('.message-quote').last()).toContainText('你好，鲍勃');
    await alice.locator('.message-quote').last().click();
    await expect(alice.locator('.message-row.flash')).toHaveCount(1);
  });

  test('编辑与撤回，撤回同时清掉附件对象', async () => {
    const row = alice.locator('.message-row', { hasText: '这是引用回复' }).first();
    await row.hover();
    await row.locator('[data-edit-message]').click();
    await expect(alice.locator('#composer-context')).toHaveAttribute('data-mode', 'edit');
    await alice.locator('#message-input').fill('这是改过的回复');
    await alice.locator('#message-input').press('Enter');
    await expect(alice.locator('.message-bubble', { hasText: '这是改过的回复' })).toContainText('已编辑');
    await expect(bob.locator('.message-bubble', { hasText: '这是改过的回复' })).toBeVisible();

    const mediaSrc = await alice.locator('.message-attachment.media img').last().getAttribute('src');
    const mediaRow = alice.locator('.message-row').filter({ has: alice.locator(`img[src="${mediaSrc}"]`) });
    await mediaRow.hover();
    await mediaRow.locator('[data-delete-message]').click();
    await expect(alice.locator('.message-bubble.deleted').last()).toContainText('消息已撤回');

    const response = await alice.request.get(mediaSrc);
    expect(response.status()).toBe(404);
  });

  test('群组：创建、改名、踢人、解散', async () => {
    await alice.locator('[data-view="chats"]').click();
    await alice.locator('#new-group-button').click();
    await alice.locator('#group-form input[name="title"]').fill('测试小组');
    await alice.locator(`#group-member-picker input[value="${accounts.bob.id}"]`).check();
    await alice.locator('#group-submit').click();
    await alice.locator('#chat-status.connected').waitFor();
    await expect(alice.locator('#chat-title')).toHaveText('测试小组');

    promptAnswer = '改名后的小组';
    await alice.locator('#chat-details-button').click();
    await alice.locator('[data-detail-action="rename"]').click();
    await expect(alice.locator('#chat-title')).toHaveText('改名后的小组');
    await expect(alice.locator('.system-row').last()).toContainText('改名后的小组');

    await bob.reload();
    await bob.locator('#app-view').waitFor({ state: 'visible' });
    await bob.locator('.chat-item', { hasText: '改名后的小组' }).click();
    await bob.locator('#chat-status.connected').waitFor();

    await alice.locator(`[data-remove-member="${accounts.bob.id}"]`).click();
    await expect(alice.locator('.system-row').last()).toContainText('移出了群组');
    await expect(bob.locator('#toast')).toContainText('你已被移出群组');
    await expect(bob.locator('#conversation-empty')).toBeVisible();

    await alice.locator('[data-detail-action="disband"]').click();
    await expect(alice.locator('#toast')).toContainText('群组已解散');
    await expect(alice.locator('.chat-item', { hasText: '改名后的小组' })).toHaveCount(0);
  });

  test('拉黑后无法继续发消息，解除后恢复', async () => {
    await bob.locator('[data-view="chats"]').click();
    await bob.locator('.chat-item', { hasText: '爱丽丝' }).first().click();
    await bob.locator('#chat-status.connected').waitFor();

    await openContacts(alice);
    await alice.locator(`[data-block-user="${accounts.bob.id}"]`).click();
    await expect(alice.locator('#toast')).toContainText('已拉黑');
    await expect(alice.locator('.section-caption', { hasText: '黑名单' })).toBeVisible();

    await bob.locator('#message-input').fill('还能发出去吗');
    await bob.locator('#message-input').press('Enter');
    await expect(bob.locator('#toast')).toContainText('已拉黑');
    await expect(bob.locator('.message-bubble', { hasText: '还能发出去吗' })).toHaveCount(0);

    await alice.locator(`[data-unblock-user="${accounts.bob.id}"]`).click();
    await expect(alice.locator('#toast')).toContainText('已解除拉黑');
  });
});
