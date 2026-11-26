import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_WAIT_SECONDS,
  MCP_PROTOCOL_VERSION,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  clampWaitSeconds,
  redactSensitiveText,
} from './constants.mjs';
import { BrowserSession, parseCookieFile } from './cdp.mjs';
import { probeMediaFile } from './media-probe.mjs';
import { LocalStorage } from './storage.mjs';
import { PublishJobRunner } from './job-runner.mjs';
import {
  getAdapter,
  listPlatformSpecs,
  resolvePlatformId,
} from './adapters/index.mjs';

const PLATFORM_ENUM = ['xiaohongshu', 'douyin', 'x', 'bilibili'];

export const TOOLS = [
  {
    name: 'list_platforms',
    description: '只读列出本插件支持的视频发布平台（小红书、抖音、推特/X、B站）、别名、规格限制与能力矩阵。',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'check_accounts',
    description: '只读检查本机 Chrome（复用 TapCanvas CDP 或独立持久化配置目录）中各平台创作者中心的登录状态。不会输出明文 Cookie。',
    inputSchema: {
      type: 'object',
      properties: {
        platforms: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：待检查平台列表（如 ["xiaohongshu", "douyin", "x", "bilibili"]，也支持别名 xhs/dy/twitter/b站）；省略时检查全部支持平台。',
        },
        cookieFiles: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: '可选：按平台提供的 0600 Cookie 文件路径映射（如 {"xiaohongshu": "/path/to/xhs.cookie"}）。',
        },
        cdpUrl: {
          type: 'string',
          description: '可选：覆盖 TAPCANVAS_BROWSER_CDP 调试地址。',
        },
      },
    },
  },
  {
    name: 'open_login',
    description: '在可见的真实 Chrome 窗口中打开指定平台创作者登录页，供用户本人扫码或短信登录并自动保存登录态到持久化配置目录。',
    inputSchema: {
      type: 'object',
      required: ['platform'],
      properties: {
        platform: {
          type: 'string',
          description: '目标平台（xiaohongshu / douyin / x / bilibili，支持别名 xhs / dy / twitter / b站）。',
        },
        cdpUrl: {
          type: 'string',
          description: '可选：覆盖 TAPCANVAS_BROWSER_CDP 调试地址。',
        },
      },
    },
  },
  {
    name: 'prepare_publish_plan',
    description: '校验本地视频/封面文件（SHA-256、大小、格式与可选 ffprobe 参数）、按平台适配文案/标签/定时规则、检查历史重复发布记录并生成持久化发布计划 planId。不会触碰外部平台。',
    inputSchema: {
      type: 'object',
      required: ['videoPath', 'title', 'platforms'],
      properties: {
        videoPath: {
          type: 'string',
          description: '待发布本地视频的绝对或相对路径。',
        },
        title: {
          type: 'string',
          description: '通用默认标题（可在 overrides 中按平台覆盖）。',
        },
        description: {
          type: 'string',
          description: '通用默认正文/简介（可在 overrides 中按平台覆盖）。',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '通用默认话题标签列表（不带 # 或带 # 均可）。',
        },
        coverPath: {
          type: 'string',
          description: '可选：本地封面图路径（支持 jpg/jpeg/png/webp）。',
        },
        platforms: {
          type: 'array',
          items: { type: 'string' },
          description: '目标平台列表（如 ["xiaohongshu", "douyin", "x"]）。',
        },
        overrides: {
          type: 'object',
          description: '可选：按平台覆盖的专属文案与参数，键为平台 ID 或别名，值可含 { title, description, tags, coverPath, scheduleAt, options }。',
        },
        scheduleAt: {
          type: 'string',
          description: '可选：ISO 8601 定时发布时间（例如 "2026-12-01T18:00:00+08:00"）。',
        },
        mode: {
          type: 'string',
          enum: ['draft', 'publish'],
          description: '期望模式，默认 "draft"（存草稿/预填不发布）；设为 "publish" 时仍需在 start_publish_job 中显式传 confirmed: true。',
        },
        options: {
          type: 'object',
          description: '可选：平台扩展选项（如 original、aiGenerated、visibility、xPremium、biliCategory 等）。',
        },
      },
    },
  },
  {
    name: 'start_publish_job',
    description: '启动异步顺序多平台视频发布/存草稿任务，并等待最多 waitSeconds（默认 25 秒，上限 45 秒）返回实时进度或终态回执。默认 mode="draft"；当 mode="publish" 时必须先经用户人工确认并显式传入 confirmed=true，否则确定性拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        planId: {
          type: 'string',
          description: '可选：由 prepare_publish_plan 生成的计划 ID；传入后自动复用已校验计划。',
        },
        videoPath: {
          type: 'string',
          description: '未传 planId 时必填：本地视频路径。',
        },
        title: {
          type: 'string',
          description: '未传 planId 时必填：默认标题。',
        },
        description: {
          type: 'string',
          description: '可选：默认正文。',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：默认标签。',
        },
        coverPath: {
          type: 'string',
          description: '可选：本地封面路径。',
        },
        platforms: {
          type: 'array',
          items: { type: 'string' },
          description: '未传 planId 时必填：目标平台列表。',
        },
        overrides: {
          type: 'object',
          description: '可选：按平台覆盖参数。',
        },
        scheduleAt: {
          type: 'string',
          description: '可选：定时发布 ISO 时间。',
        },
        options: {
          type: 'object',
          description: '可选：平台扩展选项。',
        },
        mode: {
          type: 'string',
          enum: ['draft', 'publish'],
          description: '执行模式：默认 "draft"（安全存草稿/预填）；"publish" 会真正公开发布或提交定时发布，必须配合 confirmed=true。',
        },
        confirmed: {
          type: 'boolean',
          description: '仅当 mode="publish" 且已获得用户明确人工批准（如 mcp__tapcanvas__approval 批准）时传 true。',
        },
        cookieFiles: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: '可选：按平台提供的 0600 Cookie 文件路径映射。',
        },
        cdpUrl: {
          type: 'string',
          description: '可选：覆盖 TAPCANVAS_BROWSER_CDP 调试地址。',
        },
        waitSeconds: {
          type: 'integer',
          description: '本次调用最多等待多少秒（默认 25，范围 0–45，避免触发 MCP 单次调用超时）。',
        },
      },
    },
  },
  {
    name: 'get_publish_job',
    description: '查询并等待异步发布任务（jobId）的最新进度、各平台结果（draft_saved/published/scheduled/needs_login/needs_verification/failed）与截图路径。',
    inputSchema: {
      type: 'object',
      required: ['jobId'],
      properties: {
        jobId: {
          type: 'string',
          description: 'start_publish_job 返回的 jobId。',
        },
        waitSeconds: {
          type: 'integer',
          description: '最多等待多少秒（默认 25，范围 0–45）。',
        },
      },
    },
  },
  {
    name: 'cancel_publish_job',
    description: '取消正在执行中的多平台发布任务，停止尚未开始的后续平台。',
    inputSchema: {
      type: 'object',
      required: ['jobId'],
      properties: {
        jobId: {
          type: 'string',
          description: '待取消任务的 jobId。',
        },
      },
    },
  },
  {
    name: 'list_publish_history',
    description: '只读查询本地持久化的发布与存草稿历史回执账本（history.jsonl），用于去重核查与审计。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'integer',
          description: '最多返回条数（默认 20，最大 200）。',
        },
        platform: {
          type: 'string',
          description: '可选：按平台筛选（xiaohongshu / douyin / x / bilibili 或别名）。',
        },
      },
    },
  },
];

function makePlanId() {
  return `plan_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function normalizeOverrideMap(overrides, resolveId) {
  const map = new Map();
  if (!overrides || typeof overrides !== 'object') return map;
  for (const [rawKey, value] of Object.entries(overrides)) {
    const id = resolveId(rawKey);
    if (id && value && typeof value === 'object') {
      map.set(id, value);
    }
  }
  return map;
}

function normalizeValidation(adapter, rawValidation, fallbackPayload) {
  if (!rawValidation || typeof rawValidation !== 'object') {
    return {
      ok: true,
      payload: fallbackPayload,
      warnings: [],
      errors: [],
    };
  }
  const errors = Array.isArray(rawValidation.errors) ? rawValidation.errors : [];
  const warnings = Array.isArray(rawValidation.warnings) ? rawValidation.warnings : [];
  const ok = rawValidation.ok !== undefined
    ? Boolean(rawValidation.ok)
    : (rawValidation.valid !== undefined ? Boolean(rawValidation.valid) : errors.length === 0);
  const normalized = rawValidation.adapted || rawValidation.normalized || rawValidation.payload || fallbackPayload;
  return {
    ok,
    payload: {
      ...fallbackPayload,
      ...normalized,
      platform: adapter.spec.id,
    },
    warnings,
    errors,
  };
}

export function createPublisherService(deps = {}) {
  const env = deps.env || process.env;
  const storage = deps.storage || new LocalStorage({ env, dataDir: deps.dataDir });
  const resolveId = deps.resolvePlatformId || resolvePlatformId;
  const lookupAdapter = deps.getAdapter || getAdapter;
  const listSpecs = deps.listPlatformSpecs || listPlatformSpecs;
  const probeMedia = deps.probeMediaFile || ((file, opts) => probeMediaFile(file, { ...opts, env }));
  const sessionFactory = deps.sessionFactory || ((opts) => BrowserSession.connect({ ...opts, env }));

  const runner = deps.runner || new PublishJobRunner({
    storage,
    getAdapter: lookupAdapter,
    resolvePlatformId: resolveId,
    sessionFactory,
    env,
  });

  async function listPlatforms() {
    return {
      ok: true,
      plugin: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
      safetyDefaults: {
        defaultMode: 'draft',
        publishRequiresConfirmedTrue: true,
        sequentialExecution: true,
        waitSecondsRange: [0, 45],
      },
      platforms: listSpecs(),
    };
  }

  async function checkAccounts(args = {}) {
    const requested = Array.isArray(args.platforms) && args.platforms.length > 0
      ? args.platforms
      : PLATFORM_ENUM;

    const resolvedIds = [];
    const unknown = [];
    for (const raw of requested) {
      const id = resolveId(raw);
      if (!id) unknown.push(String(raw));
      else if (!resolvedIds.includes(id)) resolvedIds.push(id);
    }
    if (unknown.length > 0) {
      return {
        ok: false,
        error: `不支持的平台：${unknown.join(', ')}（支持：${PLATFORM_ENUM.join(', ')}）`,
      };
    }

    const cookieFiles = args.cookieFiles && typeof args.cookieFiles === 'object' ? args.cookieFiles : {};
    let session = null;
    try {
      session = await sessionFactory({ cdpUrl: args.cdpUrl || '' });
      const accounts = [];
      for (const platformId of resolvedIds) {
        const adapter = lookupAdapter(platformId);
        let page = null;
        try {
          page = await session.newPage();
          const cookiePath = cookieFiles[platformId]
            || Object.entries(cookieFiles).find(([k]) => resolveId(k) === platformId)?.[1];
          if (cookiePath) {
            const cookies = parseCookieFile(cookiePath, platformId);
            if (cookies.length > 0) await page.setCookies(cookies);
          }
          const result = await adapter.checkAuth(page);
          const loggedIn = Boolean(result?.loggedIn ?? result?.status === 'logged_in');
          const accountName = result?.accountName || result?.handle || null;
          accounts.push({
            platform: platformId,
            name: adapter.spec.name,
            status: result?.status || (loggedIn ? 'logged_in' : 'needs_login'),
            loggedIn,
            accountName,
            handle: accountName,
            loginUrl: adapter.spec.loginUrl,
            message: redactSensitiveText(result?.message || ''),
          });
        } catch (error) {
          accounts.push({
            platform: platformId,
            name: adapter.spec.name,
            status: 'error',
            loggedIn: false,
            handle: null,
            loginUrl: adapter.spec.loginUrl,
            message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
          });
        } finally {
          if (page && typeof page.close === 'function') {
            try { await page.close(); } catch { /* ignore */ }
          }
        }
      }
      return {
        ok: true,
        browser: {
          source: session.source || 'cdp',
          profileDir: session.profileDir || null,
        },
        accounts,
      };
    } catch (error) {
      return {
        ok: false,
        error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      };
    } finally {
      if (session && typeof session.close === 'function') {
        try { await session.close({ closeOwnedTabs: true }); } catch { /* ignore */ }
      }
    }
  }

  async function openLogin(args = {}) {
    const platformId = resolveId(args.platform);
    if (!platformId) {
      return {
        ok: false,
        error: `不支持的平台：${args.platform || '(空)'}（支持：${PLATFORM_ENUM.join(', ')}）`,
      };
    }
    const adapter = lookupAdapter(platformId);
    let session = null;
    try {
      session = await sessionFactory({ cdpUrl: args.cdpUrl || '' });
      const page = await session.newPage();
      if (typeof session.keepTargetOpen === 'function') {
        session.keepTargetOpen(page);
      }
      const res = await adapter.openLogin(page);
      return {
        ok: true,
        platform: platformId,
        name: adapter.spec.name,
        loginUrl: res?.url || adapter.spec.loginUrl,
        profileDir: session.profileDir || null,
        message: res?.message || `已在可见 Chrome 窗口打开 ${adapter.spec.name} 登录页，请完成扫码/短信登录后再调用 check_accounts 复查。`,
      };
    } catch (error) {
      return {
        ok: false,
        platform: platformId,
        error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      };
    } finally {
      if (session && typeof session.close === 'function') {
        // Keep the login tab open so the user can interact with it!
        try { await session.close({ closeOwnedTabs: false }); } catch { /* ignore */ }
      }
    }
  }

  async function preparePublishPlan(args = {}) {
    const rawPlatforms = Array.isArray(args.platforms) ? args.platforms : [];
    if (!rawPlatforms.length) {
      return { ok: false, error: 'platforms 不能为空，请至少指定一个目标平台' };
    }

    const resolvedIds = [];
    const unknown = [];
    for (const raw of rawPlatforms) {
      const id = resolveId(raw);
      if (!id) unknown.push(String(raw));
      else if (!resolvedIds.includes(id)) resolvedIds.push(id);
    }
    if (unknown.length > 0) {
      return {
        ok: false,
        error: `不支持的平台：${unknown.join(', ')}（支持：${PLATFORM_ENUM.join(', ')}）`,
      };
    }

    const mode = String(args.mode || 'draft').trim().toLowerCase();
    if (mode !== 'draft' && mode !== 'publish') {
      return { ok: false, error: `不支持的模式：${mode}（仅支持 draft 或 publish）` };
    }

    const video = await probeMedia(args.videoPath, { kind: 'video' });
    if (!video.ok) {
      return { ok: false, error: video.error, video };
    }

    let defaultCover = null;
    if (args.coverPath) {
      defaultCover = await probeMedia(args.coverPath, { kind: 'cover' });
      if (!defaultCover.ok) {
        return { ok: false, error: defaultCover.error, cover: defaultCover };
      }
    }

    const overrideMap = normalizeOverrideMap(args.overrides, resolveId);
    const baseTags = Array.isArray(args.tags) ? args.tags : [];
    const baseOptions = args.options && typeof args.options === 'object' ? args.options : {};

    const items = [];
    const planWarnings = [...(video.warnings || []), ...(defaultCover?.warnings || [])];
    const planErrors = [];

    for (const platformId of resolvedIds) {
      const adapter = lookupAdapter(platformId);
      const ov = overrideMap.get(platformId) || {};
      let itemCover = defaultCover;
      if (ov.coverPath && ov.coverPath !== args.coverPath) {
        itemCover = await probeMedia(ov.coverPath, { kind: 'cover' });
        if (!itemCover.ok) {
          planErrors.push(`${platformId}: ${itemCover.error}`);
        }
      }

      const candidatePayload = {
        platform: platformId,
        videoPath: video.path,
        mediaInfo: {
          sizeBytes: video.sizeBytes,
          sizeMb: video.sizeMb,
          durationSec: video.durationSec,
          width: video.width,
          height: video.height,
        },
        videoSizeMb: video.sizeMb,
        durationSec: video.durationSec,
        width: video.width,
        height: video.height,
        title: ov.title !== undefined ? String(ov.title) : String(args.title || ''),
        description: ov.description !== undefined ? String(ov.description) : String(args.description || ''),
        tags: Array.isArray(ov.tags) ? ov.tags : baseTags,
        coverPath: itemCover?.ok ? itemCover.path : null,
        scheduleAt: ov.scheduleAt !== undefined ? ov.scheduleAt : (args.scheduleAt || null),
        mode,
        options: {
          ...baseOptions,
          ...(ov.options && typeof ov.options === 'object' ? ov.options : {}),
        },
      };

      const validated = normalizeValidation(adapter, adapter.validate(candidatePayload), candidatePayload);
      for (const w of validated.warnings) planWarnings.push(`[${platformId}] ${w}`);
      for (const e of validated.errors) planErrors.push(`[${platformId}] ${e}`);

      items.push({
        ...validated.payload,
        platform: platformId,
        platformName: adapter.spec.name,
        valid: validated.ok,
        warnings: validated.warnings,
        errors: validated.errors,
      });
    }

    const duplicates = storage.findDuplicates(video.sha256, resolvedIds);
    if (duplicates.length > 0) {
      planWarnings.push(`检测到该视频（SHA-256 前 12 位 ${video.sha256.slice(0, 12)}）在历史账本中已有 ${duplicates.length} 条记录，请注意避免重复发布`);
    }

    const planId = makePlanId();
    const plan = {
      planId,
      createdAt: new Date().toISOString(),
      mode,
      video,
      cover: defaultCover,
      platforms: resolvedIds,
      items,
      duplicates,
      warnings: planWarnings,
      errors: planErrors,
      ready: planErrors.length === 0,
    };

    storage.savePlan(plan);

    return {
      ok: planErrors.length === 0,
      planId,
      mode,
      ready: planErrors.length === 0,
      video,
      cover: defaultCover,
      items,
      duplicates,
      warnings: planWarnings,
      errors: planErrors,
      nextStep: mode === 'publish'
        ? '若确认公开发布，请先经用户批准（如 mcp__tapcanvas__approval），再调用 start_publish_job({ planId, mode: "publish", confirmed: true })。'
        : '建议先以默认草稿模式调用 start_publish_job({ planId, mode: "draft" })。',
    };
  }

  async function startPublishJob(args = {}) {
    const requestedMode = String(args.mode || '').trim().toLowerCase();

    let plan = null;
    if (args.planId) {
      plan = storage.getPlan(args.planId);
      if (!plan) {
        return { ok: false, error: `未找到发布计划：${args.planId}` };
      }
    }

    const effectiveMode = requestedMode || plan?.mode || 'draft';
    if (effectiveMode !== 'draft' && effectiveMode !== 'publish') {
      return { ok: false, error: `不支持的发布模式：${effectiveMode}（仅支持 draft 或 publish）` };
    }

    // Fail-closed gate BEFORE touching disk/browser or preparing inline plan.
    if (effectiveMode === 'publish' && args.confirmed !== true) {
      return {
        ok: false,
        status: 'confirmation_required',
        mode: 'publish',
        planId: plan?.planId || args.planId || null,
        error: '公开发布（mode="publish"）必须先经人工批准并显式传入 confirmed: true。默认请使用 mode: "draft" 安全存草稿。',
        approvalRequired: {
          planId: plan?.planId || args.planId || null,
          platforms: plan?.platforms || args.platforms || [],
          videoPath: plan?.video?.path || args.videoPath || null,
          mode: 'publish',
          hint: '请先向用户展示计划内容并调用 mcp__tapcanvas__approval，获得批准后再传 confirmed: true。',
        },
      };
    }

    if (!plan) {
      const prepared = await preparePublishPlan({ ...args, mode: effectiveMode });
      if (!prepared.ok) return prepared;
      plan = storage.getPlan(prepared.planId);
    }

    if (!plan.ready) {
      return {
        ok: false,
        status: 'validation_failed',
        planId: plan.planId,
        errors: plan.errors,
        error: `发布计划存在校验错误，已阻止执行：${(plan.errors || []).join('；')}`,
      };
    }

    return runner.startJob(plan, {
      mode: effectiveMode,
      confirmed: args.confirmed === true,
      cookieFiles: args.cookieFiles,
      cdpUrl: args.cdpUrl,
      waitSeconds: clampWaitSeconds(args.waitSeconds, DEFAULT_WAIT_SECONDS),
    });
  }

  async function getPublishJob(args = {}) {
    const jobId = String(args.jobId || '').trim();
    if (!jobId) return { ok: false, error: '缺少必填参数 jobId' };
    return runner.waitForJob(jobId, clampWaitSeconds(args.waitSeconds, DEFAULT_WAIT_SECONDS));
  }

  async function cancelPublishJob(args = {}) {
    const jobId = String(args.jobId || '').trim();
    if (!jobId) return { ok: false, error: '缺少必填参数 jobId' };
    return runner.cancelJob(jobId);
  }

  async function listPublishHistory(args = {}) {
    let platform = null;
    if (args.platform) {
      platform = resolveId(args.platform);
      if (!platform) {
        return {
          ok: false,
          error: `不支持的筛选平台：${args.platform}`,
        };
      }
    }
    const entries = storage.listHistory({ limit: args.limit, platform });
    return {
      ok: true,
      count: entries.length,
      historyFile: storage.historyFile,
      entries,
    };
  }

  const handlers = {
    list_platforms: () => listPlatforms(),
    check_accounts: (args) => checkAccounts(args),
    open_login: (args) => openLogin(args),
    prepare_publish_plan: (args) => preparePublishPlan(args),
    start_publish_job: (args) => startPublishJob(args),
    get_publish_job: (args) => getPublishJob(args),
    cancel_publish_job: (args) => cancelPublishJob(args),
    list_publish_history: (args) => listPublishHistory(args),
  };

  return {
    storage,
    runner,
    handlers,
    callTool: async (name, args = {}) => {
      const fn = handlers[name];
      if (!fn) throw new Error(`Unknown tool: ${name}`);
      return fn(args || {});
    },
  };
}

function writeMessage(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function replyResult(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

export function startStdioServer(deps = {}) {
  const service = createPublisherService(deps);

  async function handleToolCall(id, params) {
    const name = params && typeof params.name === 'string' ? params.name : '';
    const handler = service.handlers[name];
    if (!handler) return replyError(id, -32602, `Unknown tool: ${name}`);
    try {
      const data = await handler((params && params.arguments) || {});
      return replyResult(id, {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        isError: Boolean(data && data.ok === false),
      });
    } catch (error) {
      const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
      process.stderr.write(`[${PLUGIN_NAME}] tool ${name} error: ${message}\n`);
      return replyResult(id, {
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }, null, 2) }],
        isError: true,
      });
    }
  }

  async function handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    const { id, method, params } = msg;
    if (method === 'notifications/initialized') return;
    if (id === undefined || id === null) return;

    if (method === 'initialize') {
      const protocolVersion = (params && params.protocolVersion) || MCP_PROTOCOL_VERSION;
      return replyResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: PLUGIN_NAME, version: PLUGIN_VERSION },
      });
    }
    if (method === 'ping') return replyResult(id, {});
    if (method === 'tools/list') return replyResult(id, { tools: TOOLS });
    if (method === 'tools/call') return handleToolCall(id, params);
    return replyError(id, -32601, `Method not found: ${method}`);
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    void handleMessage(parsed);
  });

  return { rl, service };
}

function isMainEntry() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}

if (isMainEntry()) {
  startStdioServer();
}
