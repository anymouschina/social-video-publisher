import crypto from 'node:crypto';
import path from 'node:path';
import {
  DEFAULT_WAIT_SECONDS,
  DEVICE_BOUND_COOKIE_PLATFORMS,
  clampWaitSeconds,
  redactSensitiveText,
} from './constants.mjs';
import { parseCookieFile } from './cdp.mjs';
import { openBrowserSession } from './transport.mjs';

const BACKEND_ENUM = ['auto', 'bsk', 'cdp'];

function normalizeBackend(raw) {
  const val = String(raw || 'auto').trim().toLowerCase();
  return BACKEND_ENUM.includes(val) ? val : null;
}

function resolveTransportMeta(session) {
  if (!session || typeof session !== 'object') return null;
  if (session.transportMeta && typeof session.transportMeta === 'object') {
    return { ...session.transportMeta };
  }
  const backend = session.backend || (session.source === 'bsk' ? 'bsk' : 'cdp');
  return {
    backend,
    source: session.source || backend,
    ...(session.browserInstanceId ? { browserInstanceId: session.browserInstanceId } : {}),
    ...(session.browserLabel ? { browserLabel: session.browserLabel } : {}),
    ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    ...(session.cdpUrl ? { cdpUrl: session.cdpUrl } : {}),
    ...(session.profileDir !== undefined ? { profileDir: session.profileDir || null } : {}),
  };
}

function isBskSession(session) {
  if (!session || typeof session !== 'object') return false;
  return session.backend === 'bsk'
    || session.transportMeta?.backend === 'bsk'
    || session.source === 'bsk';
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function summarizeJobStatus(results, cancelled) {
  if (cancelled) return 'cancelled';
  if (!results.length) return 'failed';
  const statuses = results.map((r) => r.status);
  const allOk = statuses.every((s) => s === 'published' || s === 'scheduled' || s === 'draft_saved');
  if (allOk) return 'completed';
  const anyNeedsAction = statuses.some((s) => s === 'needs_login' || s === 'needs_verification');
  const anyOk = statuses.some((s) => s === 'published' || s === 'scheduled' || s === 'draft_saved');
  if (anyNeedsAction) return 'needs_action';
  if (anyOk) return 'partial';
  return 'failed';
}

export function shouldKeepTabOpen(platform, result) {
  if (!result) return false;
  if (result.status === 'needs_login' || result.status === 'needs_verification') return true;
  if (
    result.diagnostics?.draftMethod === 'form_populated' ||
    result.diagnostics?.draftMethod === 'composer_populated'
  ) {
    return true;
  }
  if (result.diagnostics?.keepTabOpen === true) return true;
  // On X (Twitter), draft mode leaves the populated composer open for user inspection.
  if (platform === 'x' && result.status === 'draft_saved') return true;
  return false;
}

export class PublishJobRunner {
  constructor({ storage, getAdapter, resolvePlatformId, sessionFactory, env = process.env }) {
    this.storage = storage;
    this.getAdapter = getAdapter;
    this.resolvePlatformId = resolvePlatformId;
    this.env = env;
    this.sessionFactory = sessionFactory || ((opts) => openBrowserSession({ ...opts, env: this.env }));
    this.activeJobs = new Map();
    this.waiters = new Map();
  }

  _notifyWaiters(jobId) {
    const set = this.waiters.get(jobId);
    if (!set) return;
    for (const resolve of [...set]) {
      resolve();
    }
    set.clear();
  }

  _persist(job) {
    job.updatedAt = new Date().toISOString();
    this.storage.saveJob(job);
  }

  getJob(jobId) {
    const cleanId = String(jobId || '').trim();
    if (!cleanId) return null;
    return this.activeJobs.get(cleanId) || this.storage.getJob(cleanId);
  }

  cancelJob(jobId) {
    const job = this.getJob(jobId);
    if (!job) {
      return { ok: false, error: `未找到发布任务：${jobId}` };
    }
    if (job.status !== 'running' && job.status !== 'queued') {
      return {
        ok: true,
        jobId: job.jobId,
        status: job.status,
        message: `任务已处于终态（${job.status}），无需取消`,
      };
    }
    job.cancelled = true;
    job.progress.push({
      at: new Date().toISOString(),
      platform: job.currentPlatform || null,
      stage: 'cancel_requested',
      message: '已收到取消请求，将跳过尚未开始的平台',
    });
    this._persist(job);
    return {
      ok: true,
      jobId: job.jobId,
      status: job.status,
      cancelled: true,
      message: '已标记取消，正在停止后续平台任务',
    };
  }

  async waitForJob(jobId, waitSeconds = DEFAULT_WAIT_SECONDS) {
    const job = this.getJob(jobId);
    if (!job) {
      return { ok: false, error: `未找到发布任务：${jobId}` };
    }

    const clampedSec = clampWaitSeconds(waitSeconds, DEFAULT_WAIT_SECONDS);
    if ((job.status === 'running' || job.status === 'queued') && clampedSec > 0) {
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const set = this.waiters.get(jobId);
          if (set) set.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, clampedSec * 1000);
        if (!this.waiters.has(jobId)) this.waiters.set(jobId, new Set());
        this.waiters.get(jobId).add(finish);
      });
    }

    const latest = this.getJob(jobId) || job;
    const isRunning = latest.status === 'running' || latest.status === 'queued';
    return {
      ok: true,
      done: !isRunning,
      transport: latest.transport || null,
      job: latest,
      nextAction: isRunning
        ? `任务仍在执行中（当前平台：${latest.currentPlatform || '准备中'}），请继续调用 get_publish_job(jobId="${latest.jobId}") 轮询进度`
        : '任务已结束，请查看 results 中各平台回执与截图路径',
    };
  }

  async startJob(plan, opts = {}) {
    const mode = String(opts.mode || plan.mode || 'draft').trim().toLowerCase();
    if (mode !== 'draft' && mode !== 'publish') {
      return {
        ok: false,
        status: 'invalid_mode',
        error: `不支持的发布模式：${mode}（仅支持 draft 或 publish）`,
      };
    }

    const backend = normalizeBackend(opts.backend);
    if (!backend) {
      return {
        ok: false,
        status: 'invalid_backend',
        error: `不支持的浏览器后端：${opts.backend}（仅支持 auto、bsk 或 cdp）`,
      };
    }

    // Deterministic fail-closed safety gate: publish ALWAYS requires confirmed === true.
    if (mode === 'publish' && opts.confirmed !== true) {
      return {
        ok: false,
        status: 'confirmation_required',
        mode: 'publish',
        error: '公开发布（mode="publish"）属于不可逆外部动作，必须先经人工确认并显式传入 confirmed: true。若仅需安全预填，请使用默认 mode: "draft"。',
        approvalRequired: {
          planId: plan.planId || null,
          platforms: (plan.items || []).map((item) => item.platform),
          videoPath: plan.video?.path || plan.videoPath || null,
          mode: 'publish',
          hint: '在 TapCanvas 中请先调用 mcp__tapcanvas__approval 向用户展示目标平台、视频与文案，批准后再以 confirmed: true 重新调用 start_publish_job。',
        },
      };
    }

    const items = Array.isArray(plan.items) ? plan.items : [];
    if (!items.length) {
      return {
        ok: false,
        status: 'invalid_plan',
        error: '发布计划中没有有效的目标平台条目',
      };
    }

    const jobId = makeId('job');
    const screenshotDir = this.storage.getScreenshotDir(jobId);
    const now = new Date().toISOString();
    const job = {
      jobId,
      planId: plan.planId || null,
      mode,
      status: 'running',
      transport: null,
      videoPath: plan.video?.path || plan.videoPath || '',
      videoSha256: plan.video?.sha256 || plan.videoSha256 || '',
      platforms: items.map((item) => item.platform),
      currentPlatform: null,
      screenshotDir,
      results: [],
      progress: [
        {
          at: now,
          platform: null,
          stage: 'started',
          message: `已创建多平台${mode === 'draft' ? '存草稿' : '发布'}任务（共 ${items.length} 个平台）`,
        },
      ],
      cancelled: false,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };

    this.activeJobs.set(jobId, job);
    this._persist(job);

    const cookieFiles = opts.cookieFiles && typeof opts.cookieFiles === 'object' ? opts.cookieFiles : {};
    const cdpUrl = opts.cdpUrl || '';
    const browserId = opts.browserId || '';
    const allowUnsafeCookieInjection = opts.allowUnsafeCookieInjection === true;

    // Fire sequential async runner without blocking tool call beyond waitSeconds.
    void this._executeJob(job, items, { backend, browserId, cookieFiles, cdpUrl, allowUnsafeCookieInjection });

    const waitSeconds = clampWaitSeconds(opts.waitSeconds, DEFAULT_WAIT_SECONDS);
    return this.waitForJob(jobId, waitSeconds);
  }

  async _applyCookieFileIfPresent(page, platformId, cookieFiles, { allowUnsafeCookieInjection = false, adapter = null, isBsk = false } = {}) {
    const filePath = cookieFiles[platformId]
      || Object.entries(cookieFiles).find(([key]) => this.resolvePlatformId(key) === platformId)?.[1];
    if (!filePath) {
      return { applied: false, blocked: false, skippedAlreadyLoggedIn: false, skippedReason: null, count: 0 };
    }

    // Real logged-in Chrome via BrowserSkill (bsk) already owns native cookies & device keys.
    if (isBsk) {
      return {
        applied: false,
        blocked: false,
        skippedAlreadyLoggedIn: false,
        skippedReason: 'bsk_native_browser',
        count: 0,
      };
    }

    // Device-bound cookie-transplant guard: block cross-profile cookie injection by default.
    if (DEVICE_BOUND_COOKIE_PLATFORMS.has(platformId) && !allowUnsafeCookieInjection) {
      return {
        applied: false,
        blocked: true,
        skippedAlreadyLoggedIn: false,
        skippedReason: null,
        count: 0,
        reason: 'device_bound_cookie_blocked',
      };
    }

    // Even when allowed (allowUnsafeCookieInjection=true or non-device-bound platform),
    // NEVER overwrite a persistent Chrome profile session that is already logged in.
    if (adapter && typeof adapter.checkAuth === 'function') {
      try {
        const nativeAuth = await adapter.checkAuth(page);
        if (nativeAuth && (nativeAuth.loggedIn || nativeAuth.status === 'logged_in')) {
          return {
            applied: false,
            blocked: false,
            skippedAlreadyLoggedIn: true,
            skippedReason: 'already_logged_in',
            count: 0,
          };
        }
      } catch {
        // If native auth probe throws, proceed to inject below.
      }
    }

    const cookies = parseCookieFile(filePath, platformId);
    if (cookies.length > 0) {
      await page.setCookies(cookies);
    }
    return { applied: true, blocked: false, skippedAlreadyLoggedIn: false, skippedReason: null, count: cookies.length };
  }

  async _executeJob(job, items, { backend = 'auto', browserId = '', cookieFiles, cdpUrl, allowUnsafeCookieInjection = false }) {
    let session = null;
    try {
      session = await this.sessionFactory({ backend, browserId, cdpUrl, focus: false });
      const bskNative = isBskSession(session);
      job.transport = resolveTransportMeta(session);
      this._persist(job);

      for (const item of items) {
        if (job.cancelled) {
          const cancelledResult = {
            platform: item.platform,
            status: 'cancelled',
            url: null,
            screenshotPath: null,
            message: '任务已取消，未执行该平台',
            diagnostics: {},
          };
          job.results.push(cancelledResult);
          this._recordReceipt(job, item, cancelledResult);
          this._persist(job);
          continue;
        }

        job.currentPlatform = item.platform;
        job.progress.push({
          at: new Date().toISOString(),
          platform: item.platform,
          stage: 'platform_start',
          message: `开始处理平台：${item.platform}`,
        });
        this._persist(job);

        const adapter = this.getAdapter(item.platform);
        if (!adapter) {
          const missing = {
            platform: item.platform,
            status: 'failed',
            url: null,
            screenshotPath: null,
            message: `未找到平台适配器：${item.platform}`,
            diagnostics: {},
          };
          job.results.push(missing);
          this._recordReceipt(job, item, missing);
          this._persist(job);
          continue;
        }

        let page = null;
        try {
          page = await session.newPage();

          const onProgress = (stageOrEvent, message) => {
            const event = stageOrEvent && typeof stageOrEvent === 'object'
              ? stageOrEvent
              : { stage: stageOrEvent, message };
            job.progress.push({
              at: new Date().toISOString(),
              platform: event.platform || item.platform,
              stage: String(event.stage || 'progress'),
              message: redactSensitiveText(event.message || ''),
            });
            if (job.progress.length > 200) {
              job.progress = job.progress.slice(-200);
            }
            this._persist(job);
          };

          const cookieOutcome = await this._applyCookieFileIfPresent(page, item.platform, cookieFiles, {
            allowUnsafeCookieInjection,
            adapter,
            isBsk: bskNative,
          });
          if (cookieOutcome.skippedReason === 'bsk_native_browser') {
            onProgress(
              'cookie_guard',
              `${item.platform} 已通过 BrowserSkill (bsk) 直接复用本机真实浏览器登录态与设备密钥，已自动跳过 cookieFiles 注入`,
            );
          } else if (cookieOutcome.blocked) {
            onProgress(
              'cookie_guard',
              `已阻止对设备绑定平台 ${item.platform} 注入跨配置 cookieFiles，改为直接检查持久化 Chrome 登录态`,
            );
          } else if (cookieOutcome.skippedAlreadyLoggedIn) {
            onProgress(
              'cookie_guard',
              `${item.platform} 持久化 Chrome 配置目录已处于登录状态，已跳过重复注入 cookieFiles`,
            );
          }

          const rawResult = await adapter.publishVideo(page, {
            videoPath: item.videoPath || job.videoPath,
            mediaInfo: item.mediaInfo || null,
            title: item.title || '',
            description: item.description || '',
            tags: Array.isArray(item.tags) ? item.tags : [],
            coverPath: item.coverPath || null,
            scheduleAt: item.scheduleAt || null,
            mode: job.mode,
            options: item.options || {},
            screenshotDir: job.screenshotDir,
            onProgress,
          });

          const normalizedDiagnostics = {
            ...(rawResult?.diagnostics || {}),
            ...(cookieOutcome.blocked ? { cookieInjectionBlocked: true } : {}),
            ...(cookieOutcome.skippedReason ? { cookieInjectionSkipped: cookieOutcome.skippedReason } : {}),
          };

          let normalizedMessage = redactSensitiveText(rawResult?.message || '');
          if (cookieOutcome.blocked && (rawResult?.status || 'failed') === 'needs_login') {
            const guardHint = `已拒绝向 ${item.platform} 注入跨配置 Cookie（该平台存在设备/密钥绑定，跨配置移植会触发风控强制下线）。请调用 open_login({ platform: "${item.platform}" }) 在持久化 Chrome 窗口中原生登录一次。`;
            normalizedMessage = normalizedMessage ? `${guardHint} ${normalizedMessage}` : guardHint;
          }

          const normalized = {
            platform: item.platform,
            status: rawResult?.status || 'failed',
            url: rawResult?.url || null,
            screenshotPath: rawResult?.screenshotPath || null,
            ...(cookieOutcome.blocked ? { cookieInjectionBlocked: true } : {}),
            message: normalizedMessage,
            diagnostics: normalizedDiagnostics,
          };

          if (shouldKeepTabOpen(item.platform, normalized)) {
            if (typeof session.keepTargetOpen === 'function') {
              session.keepTargetOpen(page);
            }
          } else if (page && typeof page.close === 'function') {
            await page.close();
          }

          job.results.push(normalized);
          this._recordReceipt(job, item, normalized);
          job.progress.push({
            at: new Date().toISOString(),
            platform: item.platform,
            stage: 'platform_done',
            message: `${item.platform} 完成：${normalized.status}${normalized.message ? ` — ${normalized.message}` : ''}`,
          });
          this._persist(job);
        } catch (error) {
          let errorScreenshot = null;
          if (page && typeof page.screenshot === 'function') {
            try {
              const errShotPath = path.join(job.screenshotDir, `${item.platform}-error-${Date.now()}.png`);
              errorScreenshot = await page.screenshot(errShotPath);
            } catch {
              // Ignore screenshot errors on broken page.
            }
          }
          if (page && typeof page.close === 'function') {
            try { await page.close(); } catch { /* ignore */ }
          }
          const failedResult = {
            platform: item.platform,
            status: 'failed',
            url: null,
            screenshotPath: errorScreenshot,
            message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
            diagnostics: { errorName: error instanceof Error ? error.name : 'Error' },
          };
          job.results.push(failedResult);
          this._recordReceipt(job, item, failedResult);
          job.progress.push({
            at: new Date().toISOString(),
            platform: item.platform,
            stage: 'platform_error',
            message: `${item.platform} 失败：${failedResult.message}`,
          });
          this._persist(job);
        }
      }

      job.currentPlatform = null;
      job.status = summarizeJobStatus(job.results, job.cancelled);
      job.finishedAt = new Date().toISOString();
      this._persist(job);
    } catch (error) {
      job.currentPlatform = null;
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
      job.error = message;
      job.progress.push({
        at: job.finishedAt,
        platform: null,
        stage: 'session_error',
        message: `浏览器会话初始化失败：${message}`,
      });
      this._persist(job);
    } finally {
      if (session && typeof session.close === 'function') {
        try {
          // Non-kept tabs are closed; any page marked via keepTargetOpen(page) stays open (and keeps BSK Agent Window open).
          await session.close({ closeOwnedTabs: true });
        } catch {
          // Ignore close errors.
        }
      }
      this._notifyWaiters(job.jobId);
    }
  }

  _recordReceipt(job, item, result) {
    this.storage.appendHistory({
      receiptId: makeId('rcpt'),
      jobId: job.jobId,
      planId: job.planId,
      platform: result.platform,
      mode: job.mode,
      status: result.status,
      url: result.url || null,
      screenshotPath: result.screenshotPath || null,
      videoPath: item.videoPath || job.videoPath,
      videoSha256: job.videoSha256 || '',
      title: item.title || '',
      createdAt: new Date().toISOString(),
      message: result.message || '',
    });
  }
}
