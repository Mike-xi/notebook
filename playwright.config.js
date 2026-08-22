const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8788',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run test:serve',
    url: 'http://127.0.0.1:8788/login',
    // 复用已经起着的那个。引擎 B / C 要真的 Workers AI，得手工跑 `npm run test:serve:ai`
    // （test:serve 不带 --ai，那两档只会走降级路径）；写死 false 的话这里就永远起不来。
    reuseExistingServer: true,
    timeout: 90_000,
  },
  // 只有 chromium 一个项目。曾经还有个 ipad-pro（WebKit），但它**必挂且与代码无关**：
  // 会话 cookie 带 Secure 标志，WebKit 拒绝在 http://127.0.0.1 上回传，于是每个用例都停在登录页。
  // 窄屏/手机布局改用 chromium 里覆盖 viewport 来测（见 editor-toolbar.spec.js 的「窄屏布局」）。
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
