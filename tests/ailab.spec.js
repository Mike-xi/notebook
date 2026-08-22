// AI 痕迹实验室：输入 → 引擎 A 统计 → 逐句热力 → 引擎 B 的失败降级
// 引擎 B 需要真实 Workers AI 绑定，本地 test:serve 没带 --ai，所以这里只验它的降级路径。
const { test, expect } = require('@playwright/test');

const AI_SAMPLE = `随着人工智能技术的不断发展，大语言模型在各个领域展现出了巨大的潜力。首先，它极大地提升了内容生产的效率，使得原本需要数小时完成的工作可以在几分钟内完成。其次，它降低了专业知识的获取门槛，让普通用户也能够快速理解复杂的概念。

然而，我们也需要注意到其中存在的问题。值得注意的是，模型输出的内容可能存在事实性错误，这在专业领域尤其危险。此外，过度依赖工具可能会削弱人们独立思考的能力，这一点至关重要。

综上所述，人工智能既是机遇也是挑战。我们应当以开放的心态拥抱技术，同时保持批判性思维。`;

const HUMAN_SAMPLE = `昨天调那个破工具栏调到凌晨两点。

问题出在哪呢？我一开始以为是 CSS 的锅，把 order 翻来覆去改了七八遍，没用。后来才反应过来——iOS 弹键盘的时候 dvh 根本不缩！

真是服了。visualViewport 这个 API 我以前压根没听说过，还是翻 StackOverflow 才翻到的。加了三行代码就好了。三行！`;

async function login(page) {
  await page.goto('/login');
  await page.locator('#password').fill('test-admin');
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/$/);
}

test.beforeEach(async ({ page }) => {
  await login(page);
  await page.goto('/ai-lab.html');
  await expect(page.locator('#lab-text')).toBeVisible();
});

test('未登录访问会被挡到登录页', async ({ page, context }) => {
  await context.clearCookies();
  await page.goto('/ai-lab.html');
  await expect(page).toHaveURL(/\/login/);
});

test('空文本时按钮禁用，填了才亮', async ({ page }) => {
  await expect(page.locator('#lab-run')).toBeDisabled();
  await page.fill('#lab-text', AI_SAMPLE);
  await expect(page.locator('#lab-run')).toBeEnabled();
  await expect(page.locator('#lab-count')).toContainText('词');
});

test('AI 样本判高分、人写样本判低分', async ({ page }) => {
  await page.uncheck('#lab-usellm');

  await page.fill('#lab-text', AI_SAMPLE);
  await page.click('#lab-run');
  await expect(page.locator('#lab-result')).toBeVisible();
  const ai = Number(await page.locator('#lab-a-score').textContent());
  expect(ai).toBeGreaterThan(65);

  await page.fill('#lab-text', HUMAN_SAMPLE);
  await page.click('#lab-run');
  const human = Number(await page.locator('#lab-a-score').textContent());
  expect(human).toBeLessThan(35);
  expect(ai - human).toBeGreaterThan(30);
});

test('八项指标都渲染出来，加权项权重合计为一', async ({ page }) => {
  await page.uncheck('#lab-usellm');
  await page.fill('#lab-text', AI_SAMPLE);
  await page.click('#lab-run');
  await expect(page.locator('#lab-metrics .mt')).toHaveCount(8);
  // 每条都得有非空的说明，别出现光秃秃的条
  for (const note of await page.locator('#lab-metrics .mt-note').allTextContents()) {
    expect(note.trim().length).toBeGreaterThan(5);
  }
  // 「AI 句式套路」是加分项不进加权，其余七项的权重必须正好凑满 100%
  const sum = await page.evaluate(() => window.NBTextStats
    .analyze(document.getElementById('lab-text').value)
    .metrics.filter((m) => !m.bonus)
    .reduce((a, m) => a + m.weight, 0));
  expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
});

test('AI 句式套路：公文体全中、人写不误报', async ({ page }) => {
  await page.uncheck('#lab-usellm');
  await page.fill('#lab-text', `在数字经济蓬勃发展的大背景下，推动产业转型升级是一项系统工程。面对新一轮科技革命的新形势，我们既要抓住机遇，也要防范风险。

据统计，去年全市数字经济规模突破八千亿元。这一数据充分说明，数字化转型已经成为高质量发展的新引擎。要以创新为引领，以人才为支撑，以制度为保障，进一步加强顶层设计，持续深化改革攻坚。

这不是一次简单的技术升级，而是一场发展方式的深刻变革。从政策扶持到平台搭建，每一环都是不可或缺的压舱石。`);
  await page.click('#lab-run');
  await expect(page.locator('#lab-syn-card')).toBeVisible();
  // 十二类里至少踩中八类
  expect(await page.locator('#lab-syn .sy').count()).toBeGreaterThanOrEqual(8);
  expect(Number(await page.locator('#lab-a-score').textContent())).toBeGreaterThanOrEqual(75);

  // 换成人写的影评，一处都不该命中
  await page.fill('#lab-text', HUMAN_SAMPLE);
  await page.click('#lab-run');
  await expect(page.locator('#lab-syn .sy')).toHaveCount(0);
  await expect(page.locator('#lab-syn .sy-none')).toBeVisible();
});

test('综合判定给出融合分，三档缺席时权重重新归一', async ({ page }) => {
  await page.uncheck('#lab-usellm');
  await page.fill('#lab-text', AI_SAMPLE);
  await page.click('#lab-run');
  const final = Number(await page.locator('#lab-final').textContent());
  const a = Number(await page.locator('#lab-a-score').textContent());
  // 只有引擎 A 时，融合分就等于 A
  expect(final).toBe(a);
  await expect(page.locator('#lab-final-meta')).toContainText('只有一档');
  await expect(page.locator('#lab-report-btn')).toBeEnabled();
});

test('逐句热力覆盖全文且不丢字', async ({ page }) => {
  await page.uncheck('#lab-usellm');
  await page.fill('#lab-text', AI_SAMPLE);
  await page.click('#lab-run');
  await expect(page.locator('#lab-heat-card')).toBeVisible();
  const rendered = await page.locator('#lab-heat').innerText();
  // 渲染出来的正文（含句间空白）应与原文一致
  expect(rendered.replace(/\s+/g, '')).toBe(AI_SAMPLE.replace(/\s+/g, ''));
  expect(await page.locator('#lab-heat .hs').count()).toBeGreaterThan(3);
});

test('正式文体会给出语体提示', async ({ page }) => {
  await page.uncheck('#lab-usellm');
  await page.fill('#lab-text', `本文研究半潜式水下机器人在波浪扰动下的姿态稳定问题。首先建立六自由度动力学模型，考虑附加质量、粘性阻尼与恢复力矩三部分作用。其次，针对模型参数存在不确定性的情况，设计了自适应滑模控制器，并通过 Lyapunov 方法证明了闭环系统的渐近稳定性。

仿真在 MATLAB/Simulink 平台上进行，海况取三级，有义波高 1.25 米。结果表明，与传统 PID 相比，本文方法在纵摇角超调量上降低了 42%，调节时间缩短约 3.1 秒。

需要指出的是，本文未考虑推进器饱和与执行机构延迟，这将在后续工作中补充。`);
  await page.click('#lab-run');
  await expect(page.locator('#lab-register')).toBeVisible();
  await expect(page.locator('#lab-register')).toContainText('正式书面语体');
});

test('示例按钮循环填三份对照样本', async ({ page }) => {
  const seen = new Set();
  for (let i = 0; i < 3; i++) {
    await page.click('#lab-sample');
    seen.add(await page.inputValue('#lab-text'));
  }
  expect(seen.size).toBe(3);
});

// 下面两条对「有没有 Workers AI 绑定」都成立：
//   npm run test:serve     -> 无 --ai，引擎 B/C 走降级路径
//   npm run test:serve:ai  -> 有 --ai，真的调模型
// 断言写的是两种情况共同的不变量：不卡死、不整页报错、引擎 A 不受连累。
test('引擎 B/C 无论成败都不拖累引擎 A', async ({ page }) => {
  test.setTimeout(90_000);
  await page.fill('#lab-text', AI_SAMPLE);
  await page.click('#lab-run');

  // 引擎 A 是同步算的，立刻就该有分
  expect(Number(await page.locator('#lab-a-score').textContent())).toBeGreaterThan(0);

  // 两档都必须落地：要么出结果，要么显示错误，不能一直停在「评审中/计算中」
  await expect(page.locator('#lab-judges .jg, #lab-judges .lab-wait.err')).not.toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator('#lab-ppl-body .gl-stack, #lab-ppl-body .lab-wait.err')).not.toHaveCount(0, { timeout: 60_000 });
  await expect(page.locator('#lab-b-label')).not.toHaveText('评审中');
  await expect(page.locator('#lab-c-label')).not.toHaveText('计算中');
  await expect(page.locator('#lab-run')).toBeEnabled();
});

test('接得上真 Workers AI 时，三档结论方向一致', async ({ page }) => {
  test.setTimeout(90_000);
  await page.fill('#lab-text', AI_SAMPLE);
  await page.click('#lab-run');
  await expect(page.locator('#lab-ppl-body .gl-stack, #lab-ppl-body .lab-wait.err')).not.toHaveCount(0, { timeout: 60_000 });

  // 没绑 AI 的话这条没什么可验的，跳过
  test.skip(await page.locator('#lab-ppl-body .lab-wait.err').count() > 0, '本次运行没有 Workers AI 绑定');

  const c = Number(await page.locator('#lab-c-score').textContent());
  expect(c).toBeGreaterThan(60);                       // 这是一段明显的模型输出
  await expect(page.locator('.gl-strip i')).not.toHaveCount(0);
  // GLTR 四个桶加起来必须是 100%，别出现算漏的 token
  const legend = await page.locator('.gl-legend span').allTextContents();
  const sum = legend.map((s) => Number(s.match(/(\d+)%/)[1])).reduce((a, b) => a + b, 0);
  expect(Math.abs(sum - 100)).toBeLessThanOrEqual(2);  // 各自四舍五入，容 2 个点

  await expect(page.locator('#lab-judges .jg').first()).toBeVisible({ timeout: 60_000 });
  const b = Number(await page.locator('#lab-b-score').textContent());
  expect(b).toBeGreaterThan(60);
});
