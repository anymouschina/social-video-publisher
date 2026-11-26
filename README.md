# Social Video Publisher（多平台视频发布插件）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

一条视频多平台适配并安全发布 / 存草稿至 **小红书、抖音、推特（X）与 B 站** 的原生 TapCanvas / Claude Code / Codex 插件。

A clean-room, zero-dependency Node.js ESM MCP + Skill plugin for adapting and publishing one local video across **Xiaohongshu (小红书), Douyin (抖音), X (Twitter), and Bilibili (B站)** using your local real Chrome browser over CDP.

---

## 核心特性 / Highlights

- **零第三方依赖（Zero Dependencies）**：纯 Node.js（≥ 22）内置模块实现（`WebSocket`、`fetch`、`readline`、`crypto`），无需 `npm install`、Python 或 Playwright，MCP 握手 < 100ms。
- **真实本机 Chrome CDP**：优先复用 TapCanvas 宿主浏览器（`TAPCANVAS_BROWSER_CDP` / `DevToolsActivePort`），否则自动启动本机 Chrome/Edge/Chromium 并挂载独立持久化用户目录（`~/.local/share/social-video-publisher/chrome-profile`），保留真实住宅 IP 与自然浏览器指纹，降低平台风控风险。
- **默认存草稿 + 确定性发布确认闸**：`start_publish_job` 默认 `mode: "draft"`；当 `mode: "publish"` 时，若未显式传入 `confirmed: true` 将在服务端确定性拒绝。
- **异步顺序任务模型**：多平台依次执行避免标签页焦点冲突，并支持 `start_publish_job` + `get_publish_job`（单次等待上限 45s），完美兼容 Codex 60 秒 MCP 工具超时限制。
- **视频探测与去重账本**：自动计算视频 SHA-256 与文件规格（如本机安装了 `ffprobe` 自动读取时长/分辨率/编码，未安装时优雅降级），并写入本地 `~/.local/share/social-video-publisher/history.jsonl` 防止误重复发布。

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
2. `check_accounts` — 检查各平台创作者中心登录状态。
3. `open_login` — 在可见 Chrome 窗口中打开指定平台登录页供用户扫码/短信登录。
4. `prepare_publish_plan` — 校验视频/封面文件、适配各平台文案、检测历史重复发布并生成 `planId`。
5. `start_publish_job` — 启动异步多平台存草稿/发布任务（默认 `mode: "draft"`；`mode: "publish"` 强制要求 `confirmed: true`）。
6. `get_publish_job` — 轮询异步任务进度、各平台回执状态与截图路径。
7. `cancel_publish_job` — 取消执行中的多平台发布任务。
8. `list_publish_history` — 查询本地 `history.jsonl` 历史发布/草稿账本。

---

## 安装方式 / Installation

### 1. TapCanvas Desktop（推荐）

在 TapCanvas 插件市场 **官方推荐** 中找到 **多平台视频发布（Social Video Publisher）** 点击一键安装；或直接添加仓库地址：

```text
https://github.com/anymouschina/social-video-publisher.git
```

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
- **不存储、不输出明文凭据**：登录态保存在本机 Chrome 持久化配置目录中；通过 `cookieFiles` 传入的 0600 文件仅注入 CDP 会话，日志、报错与工具返回会自动脱敏，绝不向模型暴露明文 Cookie。
- **人工主导风控节点**：遇到登录失效（`needs_login`）或短信/滑块验证（`needs_verification`）时，插件会立即暂停并返回截图路径与打开的 Chrome 标签页，由用户本人完成校验，不尝试绕过验证码或代填密码。
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
