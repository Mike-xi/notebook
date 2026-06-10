# 复习笔记网站

一个跑在 Cloudflare Pages 上的个人复习笔记管理站。支持 HTML / Markdown / PDF 三种笔记，`git push` 或站内上传即可用。

## 功能

- 📚 课程卡片首页（按学科分色）+ 最近阅读
- 📄 **多格式**：HTML / Markdown（KaTeX 公式 + 代码高亮）/ PDF（自定义 PDF.js 阅读器，连续滚动 + 缩放 + 大纲 + 文本层选中复制 + 页内搜索）
- ⬆️ **站内上传**：HTML/Markdown 存 D1，PDF 存 R2
- ✏️ **站内编辑器**：直接新建 / 编辑 Markdown 笔记，左编辑右预览（公式 + 代码高亮），Ctrl+S 保存，新建草稿防丢
- 📍 自动记录上次阅读位置（PDF/MD 同样支持，跨设备同步）
- 🔖 任意位置加书签 + 命名 + 跳转
- 📑 **目录 TOC**：自动从标题/PDF 大纲生成，点击跳转
- 🖍️ **高亮 + 批注**（HTML/Markdown）：选词 4 色高亮、加批注，重开还原
- 🔍 **搜索**：输入即时过滤课程；按 Enter 深入搜索（Vectorize 语义检索 + 全文关键词匹配），语义结果可直跳对应小节
- 🅰️ **阅读偏好**：字号 / 行距 / 阅读宽度 / 护眼色温，按课程记忆并同步云端
- 🧘 **专注模式**（滚动不再唤出工具栏）与 **分屏对话**（左正文右 AI）
- ⤓ **导出**：高亮批注 + 书签一键导出复习摘要 (.md)；打印 / 浏览器存 PDF
- 🔗 **只读分享链接**：HMAC 签名 token，默认 30 天有效，对方无需登录
- 🌙 **深浅色切换**：手动 跟随系统 / 浅 / 深 三态
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

### 2.5 创建 R2 存储桶（PDF 上传需要）

PDF 体积大、是二进制，存不进 D1，改用 R2 对象存储。**不开 R2 也能用**——只是站内上传 PDF 会失败，HTML/Markdown 不受影响。

```bash
# 首次需在 Dashboard → R2 里点一次「开通」（免费额度 10GB，可能要确认一次账单信息）
wrangler r2 bucket create cloudflare
```

桶名必须是 `cloudflare`（与 `wrangler.toml` 里的 `bucket_name` 一致）。

### 3. 在 Cloudflare Pages 创建项目

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com) → Workers & Pages → Create → Pages → Connect to Git
2. 选你的 GitHub 仓库
3. **Build settings**：framework preset 选 `None`，build command 留空，build output directory 填 `.`
4. 创建项目

### 4. 配置 D1 binding + 环境变量

在 Pages 项目的 **Settings → Bindings → D1** 添加：
- Variable name: `DB`
- D1 database: `review-db`

再在 **Settings → Bindings → R2** 添加（PDF 上传需要；`wrangler.toml` 里也声明了，多数情况会自动装配，手动加一遍更稳）：
- Variable name: `FILES`
- R2 bucket: `cloudflare`

在 **Settings → Environment variables** 添加两个 secret（**生产环境**记得勾 Encrypt）：
- `SITE_PASSWORD` = 你想要的访问密码
- `AUTH_SECRET` = 一段随机长字符串（用来签名 cookie，越长越好；可以用 `openssl rand -hex 32` 生成）

配完后 **重新部署一次**（Deployments → 最新的 → Retry deployment），让新的 binding 生效。

### 5. 访问

打开 `https://<你的项目>.pages.dev`，输入密码进入。

## 添加新课程

**方式一：站内上传**（最简单）—— 首页点「创建课程」，选 HTML / Markdown / PDF 文件即可，存数据库/R2。

**方式二：静态文件**（随仓库走、永久内置）：

1. 把文件丢到 `notes/` 目录（ASCII 文件名），比如 `notes/dl-final.html` / `dl.md` / `dl.pdf`
2. 在 `courses.json` 里加一条（`kind` = `html` | `md` | `pdf`）：
   ```json
   {
     "file": "dl-final.html",
     "title": "深度学习期末",
     "subject": "DL",
     "description": "Transformer、注意力机制",
     "color": "#34A853",
     "kind": "html",
     "tags": ["dl", "transformer"]
   }
   ```
3. `git push` → Pages 自动部署

## 本地开发

```bash
# 复制环境变量样例
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars 设置本地密码

# 启动本地 dev server（自带 D1 + R2 本地模拟，无需联网/登录 CF）
wrangler pages dev . --port 8788 --d1 DB --r2 FILES --compatibility-date 2024-09-01
```

默认在 `http://localhost:8788` 打开。

> ⚠️ 本地 D1 建表坑：`pages dev --d1 DB`（按 binding 名键的 sqlite）和 `wrangler d1 execute review-db --local`（按库名键）用的是**不同文件**。若 dev server 报 `no such table`，直接对 `pages dev` 实际用的 `.wrangler/state/v3/d1/.../<hash>.sqlite` 跑一遍 `schema.sql` 即可（progress/bookmarks/highlights 等非懒建表才需要）。

## 目录结构

```
review-site/
├── functions/
│   ├── _middleware.js       # 所有请求都过这里检查认证（/assets/* 放行）
│   ├── _lib/
│   │   ├── auth.js          # HMAC cookie 签名/验证
│   │   └── db.js            # courses/highlights 表懒建+迁移
│   └── api/
│       ├── login.js         # POST: 验证密码、下发 cookie
│       ├── logout.js        # POST: 清除 cookie
│       ├── progress.js      # GET/POST: 阅读进度
│       ├── bookmarks.js     # GET/POST/DELETE: 书签
│       ├── courses.js       # GET/POST(multipart)/DELETE: 站内课程（html/md→D1, pdf→R2）
│       ├── course-html.js   # GET: 取 D1 里的 html/md 正文
│       ├── file.js          # GET: 从 R2 流式返回 pdf（支持 Range）
│       ├── highlights.js    # GET/POST/PUT/DELETE: 高亮+批注
│       ├── search.js        # GET: 深入搜索（Vectorize 语义 + D1/静态全文）
│       ├── prefs.js         # GET/PUT: 阅读偏好等键值（reader: 前缀白名单）
│       ├── share.js         # POST: 生成只读分享 token（HMAC 无状态）
│       └── shared.js        # GET: 分享取数（公开路径，token 自鉴权）
├── notes/                   # 静态课程文件（html/md/pdf）
├── assets/
│   ├── style.css            # Material You 主题（data-theme 驱动深浅色）
│   ├── theme.js             # 深浅色三态切换
│   ├── app.js               # 首页逻辑 + 上传
│   ├── reader.js            # 阅读器外壳（进度/书签/TOC/主题分流）
│   ├── pdf-viewer.js        # PDF.js 连续滚动阅读器
│   ├── md-viewer.js         # Markdown 渲染（markdown-it+KaTeX+hljs）
│   └── highlights.js        # 高亮+批注引擎
├── index.html               # 首页（课程卡片 + 上传弹窗 + 深入搜索）
├── editor.html              # 站内 Markdown 编辑器（左编辑右预览）
├── share.html               # 只读分享页（公开，凭 token 取数）
├── reader.html              # 阅读器（iframe + 悬浮工具栏 + TOC/书签/阅读设置面板）
├── viewer-pdf.html          # PDF 阅读器外壳（reader iframe 内）
├── viewer-md.html           # Markdown 阅读器外壳（reader iframe 内）
├── login.html               # 登录页
├── courses.json             # 静态课程元数据（含 kind）
├── schema.sql               # D1 表结构
├── _headers                 # 静态资源缓存策略
└── wrangler.toml            # Cloudflare 配置（D1 + R2 绑定）
```

## 数据模型

```sql
-- 阅读进度（scroll_pct 是 0~1 的小数；PDF/MD 也用滚动比例）
progress(file PK, scroll_pct, updated_at)

-- 书签（多对一文件）
bookmarks(id PK, file, title, scroll_pct, created_at)

-- 站内上传的课程（kind=html|md|pdf；html/md 正文存 html 列，pdf 正文在 R2）
courses(file PK, title, subject, description, icon, color, tags, html, kind, created_at)

-- 高亮+批注（按正文字符偏移定位，内容静态故可还原）
highlights(id PK, file, start_off, end_off, text, color, note, created_at)
```

## 安全说明

- 密码通过 HTTPS POST 发送，服务端用环境变量对比（不存数据库）
- 登录成功后下发 HttpOnly + Secure cookie，30 天有效期
- Cookie 用 HMAC-SHA256 签名，篡改会被检测
- `AUTH_SECRET` **千万别提交到 git**

## 后续可加的功能

代码里留了扩展点，比较容易加：

- **学习时长统计 / 热力图**：reader.js 里加 visibility 监听，累计活跃时间
- **PWA 离线**：加 `manifest.json` + Service Worker
- **标签筛选**：首页加标签筛选条，按 `courses.json` 里的 tags 过滤
- **抽认卡 / 间隔重复（SRS）**：把高亮/批注转成复习卡
- **AI 学习教练**：聚合进度 / 答题 / 提问历史，生成每日总结与复习计划
