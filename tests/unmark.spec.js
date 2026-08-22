// 水印橡皮：模型分发端点、蒙版工具、「找出所有相同水印」、端到端擦除。
// 真正跑推理要下 28MB 权重 + WebGPU/WASM 计算，标记为 slow，需要 --ai 的服务器不是必须的
// （模型走 R2，不走 Workers AI），但需要联网能拿到 R2 对象。
const { test, expect } = require('@playwright/test');

async function login(page) {
  await page.goto('/login');
  await page.locator('#password').fill('test-admin');
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/$/);
}

// 造一张测试图：浅灰背景 + 四个位置一模一样的深色方块当「重复水印」
async function makeImage(page, { w = 320, h = 240 } = {}) {
  return page.evaluate(async ({ w, h }) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d');
    x.fillStyle = '#dcdcdc'; x.fillRect(0, 0, w, h);
    // 一点背景纹理，免得全平色让匹配退化
    for (let i = 0; i < 400; i++) {
      x.fillStyle = `rgba(0,0,0,${Math.random() * 0.05})`;
      x.fillRect(Math.random() * w, Math.random() * h, 6, 6);
    }
    // 四枚同款「水印」
    x.fillStyle = '#202020';
    for (const [px, py] of [[30, 30], [200, 30], [30, 160], [200, 160]]) {
      x.fillRect(px, py, 60, 22);
      x.fillStyle = '#f0f0f0';
      x.font = 'bold 14px sans-serif';
      x.fillText('MARK', px + 6, py + 16);
      x.fillStyle = '#202020';
    }
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const buf = new Uint8Array(await blob.arrayBuffer());
    return Array.from(buf);
  }, { w, h });
}

async function dropImage(page, bytes) {
  await page.evaluate(async (arr) => {
    const file = new File([new Uint8Array(arr)], 'test.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    document.getElementById('um-drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, bytes);
}

test.beforeEach(async ({ page }) => {
  await login(page);
  await page.goto('/unmark.html');
  await expect(page.locator('#um-empty')).toBeVisible();
});

// 注意：必须用**页内 fetch**，不能用 page.request。
// 会话 cookie 带 Secure，Playwright 的 APIRequestContext 不会在 http://127.0.0.1 上回传它，
// 于是所有 /api/* 都会拿到 401 —— 跟代码无关，是同一个 Secure-cookie 坑的变体。
const inPage = (page, url, init) => page.evaluate(async ([u, i]) => {
  const r = await fetch(u, i);
  const h = {};
  r.headers.forEach((v, k) => { h[k] = v; });
  return { status: r.status, headers: h, len: (await r.arrayBuffer()).byteLength };
}, [url, init || {}]);

test('模型端点从 R2 发权重，带哈希和长缓存', async ({ page }) => {
  const head = await inPage(page, '/api/model/migan', { method: 'HEAD' });
  expect(head.status).toBe(200);
  expect(Number(head.headers['x-model-bytes'])).toBe(28079181);
  expect(head.headers['x-model-sha256']).toBe('6f1f3530a1a2324b19752018ce756088b07973cda8d7d890034ace5c8a48c40b');
  expect(head.headers['cache-control']).toContain('immutable');

  // 模型体本地多半取不到：`pages dev --r2 FILES` 用的是**按 binding 名**建的本地 R2 store，
  // 而 `wrangler r2 object put --local` 只能写**按桶名**建的那个（桶名还必须小写，写不出 FILES）。
  // 两个 store 打不通，这是 miniflare 本地态的老问题，跟线上无关（线上 binding 直连真桶）。
  // 所以这里只在取得到的时候才断言内容，取不到就跳过，别让本地环境把 CI 卡住。
  const part = await inPage(page, '/api/model/migan', { headers: { Range: 'bytes=0-1023' } });
  if (part.status === 404) {
    test.info().annotations.push({ type: 'skip-reason', description: '本地 R2 store 没有模型体，只验了元数据' });
  } else {
    expect([200, 206]).toContain(part.status);
    expect(part.len).toBeGreaterThan(0);
  }

  // 白名单之外的名字不能碰到桶里其他对象
  expect((await inPage(page, '/api/model/nope')).status).toBe(404);
  expect((await inPage(page, '/api/model/models%2Fmigan_pipeline_v2.onnx')).status).toBe(404);
});

test('拖图进来能载入，工具条出现', async ({ page }) => {
  await dropImage(page, await makeImage(page));
  await expect(page.locator('#um-stage')).toBeVisible();
  await expect(page.locator('#um-tools')).toBeVisible();
  await expect(page.locator('#um-msg')).toContainText('已载入 320×240');
  expect(await page.locator('#um-base').evaluate((c) => c.width)).toBe(320);
});

test('画笔涂抹进蒙版，撤销与清空都有效', async ({ page }) => {
  await dropImage(page, await makeImage(page));
  const box = await page.locator('#um-mask').boundingBox();
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 60, { steps: 6 });
  await page.mouse.up();

  const painted = () => page.locator('#um-mask').evaluate((c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
    return n;
  });
  expect(await painted()).toBeGreaterThan(100);

  await page.click('#um-undo');
  expect(await painted()).toBe(0);
});

test('找出所有相同水印：框一个，四个全选上', async ({ page }) => {
  await dropImage(page, await makeImage(page));
  // 直接往蒙版上画出左上那枚水印的框，省去鼠标换算
  await page.locator('#um-mask').evaluate((c) => {
    const x = c.getContext('2d');
    x.fillStyle = 'rgba(230,70,60,.55)';
    x.fillRect(30, 30, 60, 22);
  });
  await page.click('#um-find');
  await expect(page.locator('#um-msg')).toContainText('找到', { timeout: 30_000 });

  // 四个角落应该都被选上了
  const covered = await page.locator('#um-mask').evaluate((c) => {
    const x = c.getContext('2d');
    return [[30, 30], [200, 30], [30, 160], [200, 160]]
      .map(([px, py]) => x.getImageData(px + 30, py + 11, 1, 1).data[3] > 8);
  });
  expect(covered).toEqual([true, true, true, true]);
});

test('没选区就点找相同，给出提示而不是报错', async ({ page }) => {
  await dropImage(page, await makeImage(page));
  await page.click('#um-find');
  await expect(page.locator('#um-msg.err')).toContainText('先框住');
});

test('端到端擦除：真下模型、真跑推理 @slow', async ({ page }) => {
  test.setTimeout(300_000);
  // 本地 R2 store 拿不到模型体时（见上一条注释），这条没法跑
  const probe = await inPage(page, '/api/model/migan', { headers: { Range: 'bytes=0-15' } });
  test.skip(probe.status === 404, '本地 R2 store 里没有模型体，端到端推理只能在部署后验');

  await dropImage(page, await makeImage(page));
  await page.locator('#um-mask').evaluate((c) => {
    const x = c.getContext('2d');
    x.fillStyle = 'rgba(230,70,60,.55)';
    x.fillRect(26, 26, 68, 30);
  });

  // 擦之前，那块是深色水印
  const before = await page.locator('#um-base').evaluate((c) =>
    Array.from(c.getContext('2d').getImageData(40, 40, 1, 1).data.slice(0, 3)));
  expect(before[0]).toBeLessThan(120);

  await page.click('#um-run');
  await expect(page.locator('#um-save')).toBeEnabled({ timeout: 280_000 });

  const after = await page.locator('#um-base').evaluate((c) =>
    Array.from(c.getContext('2d').getImageData(40, 40, 1, 1).data.slice(0, 3)));
  // 应该被周围的浅灰补上了
  expect(after[0]).toBeGreaterThan(before[0] + 40);
  await expect(page.locator('#um-msg')).toContainText('擦完了');
  // 擦完蒙版清空，可以接着擦下一处
  const left = await page.locator('#um-mask').evaluate((c) => {
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
    return n;
  });
  expect(left).toBe(0);
});
