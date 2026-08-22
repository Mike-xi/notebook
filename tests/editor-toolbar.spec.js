// 编辑器工具栏：数据化渲染 / 自定义排序显隐 / 窄屏布局。
// 跑法见 README：npm run test:serve 起 8788，然后 npx playwright test --project=desktop-chromium
const { test, expect } = require('@playwright/test');

async function login(page) {
  await page.goto('/login');
  await page.fill('#password', 'test-admin');
  await page.click('button[type=submit]');
  await expect(page).toHaveURL(/\/$/);
}

test.describe('编辑器工具栏', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/editor.html');
    await expect(page.locator('#ed-tools .ed-tool').first()).toBeVisible();
  });

  test('默认按 TOOL_DEFS 渲染，h1/h3 默认收起', async ({ page }) => {
    const ids = await page.$$eval('#ed-tools [data-md]', (els) => els.map((e) => e.dataset.md));
    expect(ids).toContain('bold');
    expect(ids).toContain('sym');
    expect(ids).toContain('outline');
    expect(ids).toContain('image');
    expect(ids).not.toContain('h1');
    expect(ids).not.toContain('h3');
    // 分隔符也在，且不是按钮
    expect(await page.locator('#ed-tools .ed-tool-sep').count()).toBe(3);
  });

  test('点工具能改正文', async ({ page }) => {
    await page.fill('#ed-input', '一行字');
    await page.locator('#ed-input').selectText();
    await page.click('#ed-tools [data-md=bold]');
    expect(await page.inputValue('#ed-input')).toBe('**一行字**');
  });

  test('隐藏后按钮消失，恢复默认能拿回来', async ({ page }) => {
    await page.click('#ed-cfg-btn');
    await expect(page.locator('#ed-cfg')).toBeVisible();
    await page.click('.cfg-item[data-id=bold] .cfg-eye');
    await expect(page.locator('#ed-tools [data-md=bold]')).toHaveCount(0);
    await page.click('#cfg-reset');
    await expect(page.locator('#ed-tools [data-md=bold]')).toHaveCount(1);
  });

  test('上移一位后顺序变了，并且刷新后还在', async ({ page }) => {
    await page.click('#ed-cfg-btn');
    const before = await page.$$eval('#cfg-list .cfg-item', (els) => els.map((e) => e.dataset.id));
    // 把第二项挪到第一
    await page.click(`.cfg-item[data-id="${before[1]}"] .cfg-move[data-dir="-1"]`);
    const after = await page.$$eval('#cfg-list .cfg-item', (els) => els.map((e) => e.dataset.id));
    expect(after[0]).toBe(before[1]);
    expect(after[1]).toBe(before[0]);

    await page.reload();
    await expect(page.locator('#ed-tools .ed-tool').first()).toBeVisible();
    const kept = await page.$$eval('#ed-tools [data-md], #ed-tools .ed-tool-sep', (els) =>
      els.map((e) => e.dataset.md || 'sep'));
    expect(kept[0]).toBe(after[0]);
  });

  test('π 面板重排后仍然能开合（节点没被重建）', async ({ page }) => {
    await page.click('#ed-cfg-btn');
    await page.click('.cfg-item[data-id=sym] .cfg-move[data-dir="-1"]');
    await page.click('#cfg-done');
    await page.click('#ed-sym-btn');
    await expect(page.locator('#ed-syms')).toBeVisible();
    await page.click('#ed-sym-btn');
    await expect(page.locator('#ed-syms')).toBeHidden();
  });

  test('隐藏 π 再显示出来，面板依然可用', async ({ page }) => {
    await page.click('#ed-cfg-btn');
    await page.click('.cfg-item[data-id=sym] .cfg-eye');
    await expect(page.locator('#ed-sym-btn')).toHaveCount(0);
    await page.click('.cfg-item[data-id=sym] .cfg-eye');
    await page.click('#cfg-done');
    await page.click('#ed-sym-btn');
    await expect(page.locator('#ed-syms')).toBeVisible();
  });
});

test.describe('窄屏布局', () => {
  test.use({ viewport: { width: 390, height: 844 } });   // iPhone 15 逻辑分辨率

  test('工具栏落在编辑区下方，⋯ 展开学科', async ({ page }) => {
    await login(page);
    await page.goto('/editor.html');
    await expect(page.locator('#ed-tools .ed-tool').first()).toBeVisible();

    const bar = await page.locator('#ed-toolbar').boundingBox();
    const main = await page.locator('#ed-main').boundingBox();
    expect(bar.y).toBeGreaterThan(main.y);

    await expect(page.locator('#ed-subject')).toBeHidden();
    await page.click('#ed-more-btn');
    await expect(page.locator('#ed-subject')).toBeVisible();

    // 视图分段控件替代了老的单按钮
    await expect(page.locator('#ed-view')).toBeVisible();
    await page.click('#ed-view .seg-btn[data-view=preview]');
    await expect(page.locator('#ed-main')).toHaveClass(/show-preview/);
    await expect(page.locator('#ed-input')).toBeHidden();
  });
});
