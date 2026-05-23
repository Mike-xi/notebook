# 复习笔记网站

一个跑在 Cloudflare Pages 上的个人复习笔记管理站。把课程 HTML 丢到 `notes/` 目录、`git push`，就能用了。

## 功能

- 📚 课程卡片首页（按学科分色）
- 📍 自动记录上次阅读位置（跨设备同步）
- ⭐ 任意位置加书签 + 命名 + 跳转
- 🔍 课程列表搜索
- 🌙 自动深浅色（跟系统）
- 🔐 密码保护（HMAC 签名 cookie）

## 快速部署

### 1. 推到 GitHub

```bash
cd review-site
git init
git add .
git commit -m "init"
git remote add origin https://github.com/<你的用户名>/review-site.git
git push -u origin main
```

### 2. 创建 D1 数据库

需要安装 wrangler：

```bash
npm install -g wrangler
wrangler login
```

创建数据库 + 初始化表：

```bash
wrangler d1 create review-db
# ↑ 会打印一个 database_id，复制下来填到 wrangler.toml 里

wrangler d1 execute review-db --remote --file=schema.sql
```

### 3. 在 Cloudflare Pages 创建项目

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages → Create → Pages → Connect to Git
2. 选你的 GitHub 仓库
3. **Build settings**：framework preset 选 `None`，build command 留空，build output directory 填 `.`
4. 创建项目

### 4. 配置 D1 binding + 环境变量

在 Pages 项目的 **Settings → Bindings → D1** 添加：
- Variable name: `DB`
- D1 database: `review-db`

在 **Settings → Environment variables** 添加两个 secret（**生产环境**记得勾 Encrypt）：
- `SITE_PASSWORD` = 你想要的访问密码
- `AUTH_SECRET` = 一段随机长字符串（用来签名 cookie，越长越好；可以用 `openssl rand -hex 32` 生成）

配完后 **重新部署一次**（Deployments → 最新的 → Retry deployment），让新的 binding 生效。

### 5. 访问

打开 `https://<你的项目>.pages.dev`，输入密码进入。

## 添加新课程

1. 把 HTML 文件丢到 `notes/` 目录，比如 `notes/dl-final.html`
2. 在 `courses.json` 里加一条：
   ```json
   {
     "file": "dl-final.html",
     "title": "深度学习期末",
     "subject": "DL",
     "description": "Transformer、注意力机制",
     "color": "#34A853",
     "tags": ["dl", "transformer"]
   }
   ```
3. `git push` → Pages 自动部署

## 本地开发

```bash
# 复制环境变量样例
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars 设置本地密码

# 启动本地 dev server（自带 D1 本地模拟）
wrangler pages dev . --d1=DB=review-db
```

默认在 `http://localhost:8788` 打开。

## 目录结构

```
review-site/
├── functions/
│   ├── _middleware.js       # 所有请求都过这里检查认证
│   ├── _lib/auth.js         # HMAC cookie 签名/验证
│   └── api/
│       ├── login.js         # POST: 验证密码、下发 cookie
│       ├── logout.js        # POST: 清除 cookie
│       ├── progress.js      # GET/POST: 阅读进度
│       └── bookmarks.js     # GET/POST/DELETE: 书签
├── notes/                   # 你的课程 HTML 都丢这里
│   ├── ml-final.html
│   ├── math-final.html
│   └── physics-final.html
├── assets/
│   ├── style.css            # Material You 主题
│   ├── app.js               # 首页逻辑
│   └── reader.js            # 阅读器逻辑（进度/书签）
├── index.html               # 首页（课程卡片）
├── reader.html              # 阅读器（iframe + 工具栏）
├── login.html               # 登录页
├── courses.json             # 课程元数据
├── schema.sql               # D1 表结构
└── wrangler.toml            # Cloudflare 配置
```

## 数据模型

```sql
-- 每个文件的阅读进度（scroll_pct 是 0~1 的小数）
progress(file PK, scroll_pct, updated_at)

-- 书签（多对一文件）
bookmarks(id PK, file, title, scroll_pct, created_at)
```

## 安全说明

- 密码通过 HTTPS POST 发送，服务端用环境变量对比（不存数据库）
- 登录成功后下发 HttpOnly + Secure cookie，30 天有效期
- Cookie 用 HMAC-SHA256 签名，篡改会被检测
- `AUTH_SECRET` **千万别提交到 git**

## 后续可加的功能

代码里留了扩展点，比较容易加：

- **高亮 + 批注**：阅读器里加 selection 监听，存 `{file, range, color, note}` 到新表
- **学习时长统计**：reader.js 里加 visibility 监听，累计活跃时间
- **PWA 离线**：加 `manifest.json` + Service Worker
- **标签筛选**：首页加标签筛选条，按 `courses.json` 里的 tags 过滤
- **AI 问答**：选中段落 → 调用你的 SJTU AI 网关
