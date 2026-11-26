# Social Video Publisher（多平台视频发布插件）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

一条视频多平台适配并安全发布 / 存草稿至 **小红书、抖音、推特（X）与 B 站** 的原生 TapCanvas / Claude Code / Codex 插件（`v0.3.0`）。

A clean-room, zero-dependency Node.js ESM MCP + Skill plugin for adapting and publishing one local video across **Xiaohongshu (小红书), Douyin (抖音), X (Twitter), and Bilibili (B站)** — **BrowserSkill (`bsk`) real-browser reuse first with automatic dedicated Chrome CDP fallback**, realistic human-like interaction pacing, and risk-control safe-pause.

---

## 核心特性 / Highlights

- **BSK 优先复用现有浏览器 + CDP 自动兜底（`v0.3.0`）**：
  - 在已连接 **BrowserSkill（`bsk`）** 的 TapCanvas Desktop 环境中，`check_accounts`、`open_login` 与 `start_publish_job` 默认（`backend: "auto"`）自动通过 `bsk` Agent Window 直接复用用户本机已登录的真实 Chrome。
  - **零重复登录、零 Cookie 移植、零设备指纹冲突**：直接继承真实 Chrome 内的原生会话与本地加密设备密钥（抖音 `bd_ticket_guard` / WebCrypto IndexedDB 密钥 / DBSC、小红书设备令牌、X `cf_clearance`、B 站登录态）。
  - 当 `bsk` 不可用或显式传入 `cdpUrl` / `backend: "cdp"` 时，自动无感回退至持久化 Chrome CDP（`~/.local/share/social-video-publisher/chrome-profile`），并在响应的 `transport` 字段中清晰回传实际后端与浏览器标签。
- **零第三方依赖（Zero Dependencies）**：纯 Node.js（≥ 22）内置模块实现（`WebSocket`、`fetch`、`readline`、`crypto`、`child_process`），无需 `npm install`、Python 或 Playwright，MCP 握手 < 100ms。
- **设备绑定 Cookie 防护与原生登录**：在 `bsk` 真实浏览器下自动跳过 `cookieFiles` 注入（记录 `cookieInjectionSkipped: "bsk_native_browser"`）；在 CDP 模式下默认阻止对 `douyin` / `xiaohongshu` / `x` 注入跨配置 `cookieFiles`，且绝不覆盖已登录会话；未登录时调用 `open_login` 拉起前台可见窗口供用户原生扫码/短信登录。
- **全链路拟人化交互与零 DOM/全局污染**：内置纯手工实现的拟人化运动学模块（`src/human.mjs`），在 CDP 模式下提供三次贝塞尔曲线 + 最小加加速度鼠标轨迹、Irwin-Hall 内部点采样、ASCII 逐键与 CJK 分块输入与平滑滚轮；在 `bsk` 模式下采用只读唯一 CSS 路径定位、悬停停顿、自然分块输入与安全 `contenteditable` 话题追加；零 `data-svp-click` DOM 属性注入、零 `window.*` 全局泄漏。
- **实时风控检测与安全暂停**：在页面导航、上传转码每一次轮询、表单填写与提交前后均运行统一守卫检测，一旦捕获验证码/短信验证弹窗或流程中途强制下线，立即中止操作与轮询、截图留证并保持标签页（及 `bsk` Agent 窗口）打开，避免重试升级风控等级。
- **默认存草稿 + 确定性发布确认闸 + 草稿标签页保护**：`start_publish_job` 默认 `mode: "draft"`；当 `mode: "publish"` 时，若未显式传入 `confirmed: true` 将在服务端确定性拒绝；未保存的预填草稿页（`form_populated`）、验证页与登录页会自动保持打开。
- **异步顺序任务模型与去重账本**：多平台依次执行避免标签页焦点冲突，支持 `start_publish_job` + `get_publish_job`（单次等待上限 45s），计算视频 SHA-256 并写入本地 `~/.local/share/social-video-publisher/history.jsonl` 防止误重复发布。

---

## 支持平台 / Supported Platforms

| 平台 | Platform ID（别名） | 标题上限 | 正文上限 | 标签上限 | 存草稿 | 正式发布 | 定时发布 | 封面图 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 小红书 | `xiaohongshu` (`xhs`) | 20 字 | 1000 字 | 10 | ✅ | ✅ | ✅（1h–14d） | ✅ |
| 抖音 | `douyin` (`dy`) | 30 字 | 1000 字 | 5 | ✅ | ✅ | ✅（2h–14d） | ✅ |
| 推特 (X) | `x` (`twitter`) | — | 280 字（Premium 25000） | 5 | ✅（预填保留） | ✅ | ❌ | ❌ |
| B 站 | `bilibili` (`b站`) | 80 字 | 2000 字 | 10 | ✅ | ✅ | ✅（2h–15d） | ✅ |

---

## MCP 工具列表 / MCP Tools (`social_pub`)

1. `list_platforms` — 列出支持平台、规格上限与能力矩阵。
2. `check_accounts` — 检查各平台创作者中心登录状态（支持可选 `backend: "auto" | "bsk" | "cdp"` 与 `browserId`，返回 `transport` 元数据）。
3. `open_login` — 在前台可见真实 Chrome / `bsk` Agent 窗口中打开指定平台登录页，供用户原生扫码/短信登录一次。
4. `prepare_publish_plan` — 校验视频/封面文件、适配各平台文案、检测历史重复发布并生成 `planId`。
5. `start_publish_job` — 启动异步多平台存草稿/发布任务（默认 `mode: "draft"`；`mode: "publish"` 强制要求 `confirmed: true`；支持可选 `backend` 与 `browserId`）。
6. `get_publish_job` — 轮询异步任务进度、`transport` 信息、各平台回执状态与截图路径。
7. `cancel_publish_job` — 取消执行中的多平台发布任务。
8. `list_publish_history` — 查询本地 `history.jsonl` 历史发布/草稿账本。

---

## 安装方式 / Installation

### 1. TapCanvas Desktop（推荐）

在 TapCanvas 插件市场 **官方推荐** 中找到 **多平台视频发布（Social Video Publisher）** 点击一键安装；或直接添加仓库地址：

```text
https://github.com/anymouschina/social-video-publisher.git
```

安装后只要 TapCanvas 已连接 BrowserSkill（`bsk`），插件会自动复用你日常已登录的真实 Chrome，无需重新扫码登录。

### 2. Claude Code

```bash
claude --plugin-dir /path/to/social-video-publisher
```

### 3. OpenAI Codex CLI

```bash
codex plugin marketplace add https://github.com/anymouschina/social-video-publisher.git
```

---

## 安全模型与隐私说明 / Safety & Privacy

- **本地优先（Local-Only）**：所有视频文件、计划 JSON、截图与发布历史均只保存在用户本机 `~/.local/share/social-video-publisher/` 目录（权限 `0700` / `0600`），不经过任何第三方云端中转服务。
- **原生会话复用、不移植设备绑定 Cookie、不输出明文凭据**：优先通过 `bsk` 直接复用用户真实浏览器的原生登录态与设备密钥（自动跳过 `cookieFiles` 注入）；CDP 兜底模式下通过 `open_login` 原生保存在本地持久化配置目录中，默认拒绝跨配置 `cookieFiles` 注入到 `douyin` / `xiaohongshu` / `x`；日志、报错与工具返回自动脱敏，绝不向模型暴露明文 Cookie。
- **人工主导风控节点（安全暂停）**：遇到登录失效（`needs_login`）或短信/滑块/风控验证（`needs_verification`）时，插件立即中止后续操作与轮询、截图留证并保持标签页与窗口打开，由用户本人完成校验，绝不循环重试、不尝试绕过验证码或代填密码。
- **提示词注入隔离**：创作者后台 DOM 与页面文案均视为不可信外部数据，Skill 明确指示 Agent 不执行页面中的任何指令。

---

## 本地开发与测试 / Development & Tests

需要 Node.js ≥ 22：

```bash
node --test tests/plugin.test.mjs
```

---

## License

[MIT](./LICENSE)
