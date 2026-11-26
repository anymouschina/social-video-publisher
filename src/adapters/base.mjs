import path from 'node:path';

/**
 * Shared helpers for clean-room social video publishing adapters.
 * Pure Node ESM stdlib only (zero third-party dependencies).
 */

export const VERIFICATION_PATTERNS = Object.freeze([
  // Session expiry / mid-flow forced logout banners
  { kind: 'session_expired', regex: /登录已过期|登录状态已失效|请重新登录/i },
  // Risk-control banners & anomalous account alerts (Douyin/ByteDance, XHS, Bilibili, X)
  {
    kind: 'risk_control',
    regex:
      /账号存在异常|操作过于频繁|系统检测到异常|安全检测未通过|触发安全检测|正在进行安全检测|账号安全检测|安全检测异常|请完成安全检测|身份核验|异常登录|触发风控|安全风控验证|风控拦截|风控限制|风控验证|风控校验|风控异常|账号存在安全风险|环境异常.*验证/i,
  },
  // SMS / Phone verification
  { kind: 'sms', regex: /接收短信验证码|获取短信验证码|输入短信验证码|发送短信验证码|短信验证|语音验证码|请输入验证码|手机号验证|验证手机号|绑定手机验证|获取验证码/i },
  { kind: 'sms', regex: /verify your phone|enter the verification code|confirmation code|sms verification|enter the code we sent/i },
  // Slider / Puzzle captcha
  { kind: 'slider', regex: /拖动滑块|向右滑动完成验证|向右拖动滑块|滑动拼图|拼图验证|滑块验证|拖动下方滑块|按住左边滑块|请拖动滑块/i },
  { kind: 'slider', regex: /slide to verify|complete the puzzle|drag the slider/i },
  // Image / Click / QR / Anti-bot captcha
  { kind: 'captcha', regex: /依次点击|点击图中|图形验证码|人机验证|行为验证|请完成安全验证|安全风控验证|完成下方验证|扫码验证|进行安全验证|需要安全验证/i },
  { kind: 'captcha', regex: /verify you are human|prove you are not a robot|arkose|funcaptcha|complete (?:the |this )?captcha|solve (?:the |this )?captcha|captcha verification|security captcha|captcha challenge/i },
  // Account security challenge
  { kind: 'security_check', regex: /请进行安全验证|身份验证以继续|账号保护验证/i },
  { kind: 'security_check', regex: /suspicious login prevented|unusual login activity|challenge required|security challenge|human challenge|complete (?:the |this )?challenge|confirm your identity|authenticate your account/i },
]);

export const VERIFICATION_URL_REGEX =
  /verifycenter|captcha|baxia|secsdk|arkose|challenge|verify\.snssdk/i;

export const RISK_LOGIN_URL_REGEX = /passport\.douyin\.com/i;

export const COMMON_VERIFICATION_SELECTORS = Object.freeze([
  'iframe[src*="verify"]',
  'iframe[src*="captcha"]',
  '.secsdk-captcha-drag-wrapper',
  '#captcha-verify-image',
  '[id*="captcha"]',
  '.baxia-dialog',
  '.geetest_panel',
]);

export const COMMON_LOGIN_TEXT_REGEX =
  /扫码登录|验证码登录|立即登录|手机号登录|密码登录|短信登录/;

function isFastHumanMode() {
  return process.env.SOCIAL_PUB_FAST_HUMAN === '1';
}

function randInt(min, max) {
  const safeMin = Number.isFinite(min) ? Math.max(0, Math.floor(min)) : 0;
  const safeMax = Number.isFinite(max) ? Math.max(safeMin, Math.floor(max)) : safeMin;
  if (safeMin === safeMax) return safeMin;
  return safeMin + Math.floor(Math.random() * (safeMax - safeMin + 1));
}

/**
 * Compute a jittered polling interval (baseMs ± ratio, default ±25%).
 * Compressed when `SOCIAL_PUB_FAST_HUMAN === '1'` for deterministic fast tests.
 *
 * @param {number} [baseMs=1500]
 * @param {number} [ratio=0.25]
 * @returns {number}
 */
export function jitteredInterval(baseMs = 1500, ratio = 0.25) {
  const safeBase = Number.isFinite(baseMs) ? Math.max(1, Number(baseMs)) : 1500;
  const safeRatio = Number.isFinite(ratio) ? Math.max(0, Math.min(0.9, Number(ratio))) : 0.25;
  const factor = 1 - safeRatio + Math.random() * (2 * safeRatio);
  if (isFastHumanMode()) {
    const compressed = Math.min(safeBase, Math.max(1, Math.round(safeBase * 0.01)));
    return Math.max(1, Math.min(20, Math.round(compressed * factor)));
  }
  return Math.max(1, Math.round(safeBase * factor));
}

/**
 * Pause for a natural human-like reading/section transition duration.
 * Uses `page.sleep(ms)` when supplied and compresses durations when `SOCIAL_PUB_FAST_HUMAN === '1'`.
 *
 * @param {{ sleep?: (ms: number) => Promise<void> } | null} page
 * @param {number} [minMs=900]
 * @param {number} [maxMs=2400]
 * @returns {Promise<number>} Actual delay duration in ms.
 */
export async function humanPause(page, minMs = 900, maxMs = 2400) {
  const safeMin = Number.isFinite(minMs) ? Math.max(0, Math.floor(minMs)) : 900;
  const safeMax = Number.isFinite(maxMs) ? Math.max(0, Math.floor(maxMs)) : Math.max(safeMin, 2400);
  const low = Math.min(safeMin, safeMax);
  const high = Math.max(safeMin, safeMax);

  const delayMs = isFastHumanMode()
    ? randInt(Math.min(low, 2), Math.min(high, 10))
    : randInt(low, high);

  if (page && typeof page.sleep === 'function') {
    await page.sleep(delayMs);
  } else {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return delayMs;
}

/**
 * Wait for a human-like randomized delay in milliseconds.
 * Delegates to `page.sleep(ms)` when a CdpPage instance is supplied.
 *
 * @param {number} [minMs=150]
 * @param {number} [maxMs=450]
 * @param {{ sleep?: (ms: number) => Promise<void> } | null} [page=null]
 * @returns {Promise<number>} Actual delay duration in ms.
 */
export async function humanDelay(minMs = 150, maxMs = 450, page = null) {
  return humanPause(page, minMs, maxMs);
}

/**
 * Perform natural pre-upload page warmup: wait 1.8–3.5s, drift cursor naturally,
 * and hover over the visible upload dropzone for 250–600ms before attaching a file.
 * Safely guards optional humanized CdpPage methods so mock pages remain compatible.
 *
 * @param {object} page
 * @param {string[]} [dropzoneSelectors=[]]
 * @returns {Promise<{ warmedUp: boolean, hovered: boolean }>}
 */
export async function warmupUploadPage(page, dropzoneSelectors = []) {
  await humanPause(page, 1800, 3500);

  if (page && typeof page.idleDrift === 'function') {
    try {
      await page.idleDrift({ steps: randInt(1, 2) });
    } catch {
      // Optional cursor drift should never abort publishing.
    }
  }

  let hovered = false;
  if (
    page &&
    typeof page.hoverAny === 'function' &&
    Array.isArray(dropzoneSelectors) &&
    dropzoneSelectors.length > 0
  ) {
    const dwellMs = isFastHumanMode() ? randInt(2, 8) : randInt(250, 600);
    try {
      const hoverRes = await page.hoverAny(dropzoneSelectors, { dwellMs });
      hovered = Boolean(hoverRes && (hoverRes.found || hoverRes.selector || hoverRes.hovered));
    } catch {
      // Optional dropzone hover should never abort publishing.
    }
  }

  return { warmedUp: true, hovered };
}

/**
 * Safely clamp text by Unicode code points so emojis / surrogate pairs are never split.
 *
 * @param {unknown} str
 * @param {number} maxChars
 * @returns {string}
 */
export function clampText(str, maxChars) {
  if (str == null) return '';
  const text = String(str).trim();
  if (maxChars == null) return text;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return '';
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return chars.slice(0, Math.floor(maxChars)).join('').trimEnd();
}

/**
 * Normalize tags into a deduplicated array of clean tag strings (without leading `#`).
 *
 * @param {string[] | string | null | undefined} tags
 * @param {number} [maxTags=10]
 * @returns {string[]}
 */
export function normalizeTags(tags, maxTags = 10) {
  if (tags == null) return [];
  const rawList = Array.isArray(tags)
    ? tags
    : String(tags).split(/[\n,，、]+/);

  const seen = new Set();
  const normalized = [];
  const cap = Number.isFinite(maxTags) && maxTags >= 0 ? Math.floor(maxTags) : Infinity;

  for (const item of rawList) {
    if (normalized.length >= cap) break;
    if (item == null) continue;
    const cleaned = String(item)
      .trim()
      .replace(/^#+/, '')
      .replace(/#+$/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(cleaned);
  }

  return normalized;
}

/**
 * Parse and format a schedule timestamp into canonical ISO-8601 UTC string.
 * Returns null if empty or invalid.
 *
 * @param {string | number | Date | null | undefined} scheduleAt
 * @returns {string | null}
 */
export function formatScheduleIso(scheduleAt) {
  if (scheduleAt == null || scheduleAt === '') return null;
  const date = scheduleAt instanceof Date ? scheduleAt : new Date(scheduleAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Format a schedule timestamp into local date/time parts for creator-portal pickers.
 *
 * @param {string | number | Date | null | undefined} scheduleAt
 * @returns {{ iso: string, year: string, month: string, day: string, hours: string, minutes: string, date: string, time: string, dateTime: string, timestampMs: number } | null}
 */
export function formatScheduleLocal(scheduleAt) {
  const iso = formatScheduleIso(scheduleAt);
  if (!iso) return null;
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  const year = String(d.getFullYear());
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  return {
    iso,
    year,
    month,
    day,
    hours,
    minutes,
    date: `${year}-${month}-${day}`,
    time: `${hours}:${minutes}`,
    dateTime: `${year}-${month}-${day} ${hours}:${minutes}`,
    timestampMs: d.getTime(),
  };
}

/**
 * Validate a scheduled publish timestamp against platform lead-time and horizon limits.
 *
 * @param {string | number | Date | null | undefined} scheduleAt
 * @param {number} minMinutes
 * @param {number} maxDays
 * @param {number} [nowMs=Date.now()]
 * @returns {{ valid: boolean, scheduled: boolean, iso: string | null, error: string | null }}
 */
export function validateScheduleWindow(scheduleAt, minMinutes, maxDays, nowMs = Date.now()) {
  if (scheduleAt == null || scheduleAt === '') {
    return { valid: true, scheduled: false, iso: null, error: null };
  }

  if (!Number.isFinite(maxDays) || maxDays <= 0) {
    return {
      valid: false,
      scheduled: true,
      iso: null,
      error: '当前平台不支持定时发布（请移除 scheduleAt 后直接存草稿或发布）',
    };
  }

  const iso = formatScheduleIso(scheduleAt);
  if (!iso) {
    return {
      valid: false,
      scheduled: true,
      iso: null,
      error: '定时发布时间格式无效，请提供有效的 ISO-8601 时间字符串（例如 2026-12-01T10:00:00+08:00）',
    };
  }

  const targetMs = new Date(iso).getTime();
  const diffMs = targetMs - nowMs;
  const minLeadMs = Math.max(0, Number(minMinutes) || 0) * 60 * 1000;
  const maxLeadMs = maxDays * 24 * 60 * 60 * 1000;

  if (diffMs < minLeadMs) {
    return {
      valid: false,
      scheduled: true,
      iso,
      error: `定时发布时间需至少晚于当前时间 ${minMinutes} 分钟`,
    };
  }

  if (diffMs > maxLeadMs) {
    return {
      valid: false,
      scheduled: true,
      iso,
      error: `定时发布时间不能超过未来 ${maxDays} 天`,
    };
  }

  return { valid: true, scheduled: true, iso, error: null };
}

/**
 * Detect SMS / phone / captcha / slider / security / risk-control / session-expired modals from visible page text.
 *
 * @param {unknown} pageText
 * @returns {{ detected: boolean, kind: 'session_expired' | 'risk_control' | 'sms' | 'slider' | 'captcha' | 'security_check' | null, matched: string | null }}
 */
export function detectVerificationPrompt(pageText) {
  if (!pageText || typeof pageText !== 'string') {
    return { detected: false, kind: null, matched: null };
  }

  for (const pattern of VERIFICATION_PATTERNS) {
    const match = pageText.match(pattern.regex);
    if (match) {
      return {
        detected: true,
        kind: pattern.kind,
        matched: match[0],
      };
    }
  }

  return { detected: false, kind: null, matched: null };
}

/**
 * Unified risk-control, verification modal, and mid-flow forced-logout detector.
 * Designed to run safely at post-navigate, every upload/transcode poll iteration,
 * pre-fill, pre-submit, and post-submit across all platform adapters.
 *
 * @param {object} page
 * @param {{
 *   platformName?: string,
 *   stage?: string,
 *   inFlow?: boolean,
 *   isLoginUrl?: (url: string) => boolean,
 *   isChallengeUrl?: (url: string) => boolean,
 *   loginSelectors?: string[],
 *   verificationSelectors?: string[],
 *   extraLoginTextRegex?: RegExp | null,
 *   pageText?: string,
 *   currentUrl?: string,
 * }} [opts]
 * @returns {Promise<
 *   | { blocked: false, url: string }
 *   | {
 *       blocked: true,
 *       status: 'needs_verification' | 'needs_login',
 *       riskReason: 'verification_modal' | 'risk_control_banner' | 'session_invalidated_mid_flow',
 *       url: string,
 *       message: string,
 *       diagnostics: Record<string, unknown>,
 *     }
 * >}
 */
export async function checkPageGuardState(page, opts = {}) {
  const platformName = opts.platformName || '平台';
  const stage = opts.stage || 'flow';
  const inFlow = Boolean(opts.inFlow);

  let currentUrl = typeof opts.currentUrl === 'string' ? opts.currentUrl : '';
  if (!currentUrl && page && typeof page.url === 'function') {
    try {
      currentUrl = (await page.url()) || '';
    } catch {
      currentUrl = '';
    }
  }

  const pageText = typeof opts.pageText === 'string' ? opts.pageText : await readGuardPageText(page);
  const mergedVerifySelectors = [
    ...new Set([
      ...COMMON_VERIFICATION_SELECTORS,
      ...(Array.isArray(opts.verificationSelectors) ? opts.verificationSelectors : []),
    ]),
  ];
  const loginSelectors = Array.isArray(opts.loginSelectors) ? opts.loginSelectors : [];

  // 1. Challenge / Verification URL (verifycenter, captcha, baxia, secsdk, arkose, verify.snssdk, etc.)
  const challengeUrlMatched =
    VERIFICATION_URL_REGEX.test(currentUrl) ||
    (typeof opts.isChallengeUrl === 'function' && Boolean(opts.isChallengeUrl(currentUrl)));
  if (challengeUrlMatched) {
    return {
      blocked: true,
      status: 'needs_verification',
      riskReason: 'verification_modal',
      url: currentUrl,
      message: `${platformName}跳转至安全验证页，已立即中止操作并保留当前标签页。请在可见 Chrome 窗口手动完成验证。`,
      diagnostics: {
        keepTabOpen: true,
        riskReason: 'verification_modal',
        guardStage: stage,
        matchedUrl: currentUrl,
      },
    };
  }

  // 2. Visible verification / captcha DOM modal or iframe
  const verifyModal = await safeQueryAny(page, mergedVerifySelectors);
  if (verifyModal.found && verifyModal.visible) {
    const textCheck = detectVerificationPrompt(pageText);
    return {
      blocked: true,
      status: 'needs_verification',
      riskReason: 'verification_modal',
      url: currentUrl,
      message: `${platformName}弹出安全验证弹窗（${textCheck.kind || 'modal'}），已立即暂停操作并保留标签页。请在浏览器中手动完成验证。`,
      diagnostics: {
        keepTabOpen: true,
        riskReason: 'verification_modal',
        guardStage: stage,
        matchedSelector: verifyModal.selector,
        verification: textCheck.detected
          ? textCheck
          : { detected: true, kind: 'captcha', matched: verifyModal.selector },
      },
    };
  }

  // 3. Textual risk-control / verification / session-expired signals
  const textCheck = detectVerificationPrompt(pageText);
  if (textCheck.detected) {
    if (textCheck.kind === 'session_expired') {
      return {
        blocked: true,
        status: 'needs_login',
        riskReason: 'session_invalidated_mid_flow',
        url: currentUrl,
        message: inFlow
          ? `${platformName}在流程中途提示「${textCheck.matched}」，已立即中止后续操作并保留页面。请直接在当前 Chrome 窗口重新登录（或调用 open_login 原生登录），切勿跨浏览器配置注入 Cookie。`
          : `${platformName}登录状态已失效（${textCheck.matched}），请先调用 open_login 在当前 Chrome 窗口原生登录。`,
        diagnostics: {
          keepTabOpen: true,
          riskReason: 'session_invalidated_mid_flow',
          guardStage: stage,
          verification: textCheck,
        },
      };
    }

    const riskReason = textCheck.kind === 'risk_control' ? 'risk_control_banner' : 'verification_modal';
    return {
      blocked: true,
      status: 'needs_verification',
      riskReason,
      url: currentUrl,
      message:
        riskReason === 'risk_control_banner'
          ? `${platformName}触发风控提示（${textCheck.matched}），已立即中止后续操作并保留标签页。请在 Chrome 窗口中人工处理后再试，切勿频繁重试或跨配置注入 Cookie。`
          : `${platformName}触发安全验证（${textCheck.kind}: ${textCheck.matched}），已立即暂停后续操作并保留标签页。请在浏览器窗口中手动完成验证。`,
      diagnostics: {
        keepTabOpen: true,
        riskReason,
        guardStage: stage,
        verification: textCheck,
      },
    };
  }

  // 4. Mid-flow forced logout / login redirect detection (URL + visible login selectors + login keywords)
  const loginUrlMatched =
    RISK_LOGIN_URL_REGEX.test(currentUrl) ||
    (typeof opts.isLoginUrl === 'function' && Boolean(opts.isLoginUrl(currentUrl)));
  const loginDom = await safeQueryAny(page, loginSelectors);
  const loginTextMatched =
    COMMON_LOGIN_TEXT_REGEX.test(pageText) ||
    (opts.extraLoginTextRegex instanceof RegExp && opts.extraLoginTextRegex.test(pageText));

  if (loginUrlMatched || (loginDom.found && loginDom.visible) || loginTextMatched) {
    return {
      blocked: true,
      status: 'needs_login',
      riskReason: 'session_invalidated_mid_flow',
      url: currentUrl,
      message: inFlow
        ? `${platformName}在上传/编辑过程中检测到强制登出或跳转回登录页，已立即中止轮询与操作并保留页面。请直接在当前 Chrome 窗口原生登录（open_login），切勿跨浏览器注入 Cookie。`
        : `${platformName}未登录，请先调用 open_login 在当前 Chrome 窗口原生扫码/账号登录。`,
      diagnostics: {
        keepTabOpen: true,
        riskReason: 'session_invalidated_mid_flow',
        guardStage: stage,
        loginUrlMatched,
        loginSelector: loginDom.selector,
        loginTextMatched,
      },
    };
  }

  return { blocked: false, url: currentUrl };
}

/**
 * Capture an appropriate stage screenshot and construct a normalized abort result
 * when `checkPageGuardState` reports `blocked: true`. Zero retries, always keeps tab open.
 *
 * @param {object} page
 * @param {object} ctx
 * @param {object} spec
 * @param {object} guard
 * @param {Record<string, unknown>} diagnostics
 */
export async function buildGuardAbortResult(page, ctx, spec, guard, diagnostics) {
  const shotStage =
    guard.riskReason === 'session_invalidated_mid_flow'
      ? (guard.diagnostics?.guardStage === 'post_navigate' ? 'needs_login' : 'session_expired')
      : guard.riskReason === 'risk_control_banner'
        ? 'risk_control'
        : 'verification';

  diagnostics.keepTabOpen = true;
  diagnostics.riskReason = guard.riskReason;
  const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, shotStage, diagnostics);
  return buildResult({
    platform: spec.id,
    status: guard.status,
    url: guard.url || (await page.url().catch(() => null)) || null,
    screenshotPath,
    message: guard.message,
    diagnostics: {
      ...diagnostics,
      ...(guard.diagnostics || {}),
      keepTabOpen: true,
      riskReason: guard.riskReason,
    },
  });
}

/**
 * Construct a normalized adapter publish result object.
 * Supports either an options object `buildResult({ platform, status, ... })`
 * or positional arguments `buildResult(platform, status, extra)`.
 *
 * @returns {{ platform: string, status: string, url: string | null, screenshotPath: string | null, message: string, diagnostics: Record<string, unknown> }}
 */
export function buildResult(platformOrObj, status, extra = {}) {
  if (platformOrObj && typeof platformOrObj === 'object') {
    const {
      platform = 'unknown',
      status: objStatus = 'failed',
      url = null,
      screenshotPath = null,
      message = '',
      diagnostics = {},
    } = platformOrObj;
    return {
      platform,
      status: objStatus,
      url: url ?? null,
      screenshotPath: screenshotPath ?? null,
      message: message ?? '',
      diagnostics: diagnostics && typeof diagnostics === 'object' ? { ...diagnostics } : {},
    };
  }

  const details = extra && typeof extra === 'object' ? extra : {};
  return {
    platform: String(platformOrObj || 'unknown'),
    status: String(status || 'failed'),
    url: details.url ?? null,
    screenshotPath: details.screenshotPath ?? null,
    message: details.message ?? '',
    diagnostics: details.diagnostics && typeof details.diagnostics === 'object' ? { ...details.diagnostics } : {},
  };
}

const GUARD_TEXT_EXCLUDE_SELECTOR =
  '[contenteditable="true"], [contenteditable=""], textarea, input, script, style, noscript, article[data-testid="tweet"]';

/**
 * Strictly read-only guard text reader for `checkPageGuardState`.
 * Uses `document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)` to skip
 * user-editable inputs (`contenteditable`, `textarea`, `input`), non-visual tags
 * (`script`, `style`, `noscript`), and background X Home timeline tweets
 * (`article[data-testid="tweet"]`) so user-typed copy or background feed text
 * never triggers false-positive risk-control aborts.
 * Falls back to `document.body.innerText` when `createTreeWalker` is absent.
 *
 * @param {object} page
 * @returns {Promise<string>}
 */
export async function readGuardPageText(page) {
  if (!page || typeof page.evaluate !== 'function') return '';
  try {
    const text = await page.evaluate((excludeSelector) => {
      if (typeof document === 'undefined' || !document.body) return '';
      if (typeof document.createTreeWalker !== 'function') {
        return document.body.innerText || document.body.textContent || '';
      }

      const SHOW_TEXT = typeof NodeFilter !== 'undefined' && NodeFilter.SHOW_TEXT ? NodeFilter.SHOW_TEXT : 4;
      const FILTER_ACCEPT =
        typeof NodeFilter !== 'undefined' && NodeFilter.FILTER_ACCEPT ? NodeFilter.FILTER_ACCEPT : 1;
      const FILTER_SKIP =
        typeof NodeFilter !== 'undefined' && NodeFilter.FILTER_SKIP ? NodeFilter.FILTER_SKIP : 3;

      const isHiddenElement = (el) => {
        if (!el || typeof getComputedStyle !== 'function') return false;
        try {
          const style = getComputedStyle(el);
          if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) {
            return true;
          }
        } catch {
          // Ignore getComputedStyle errors on detached/mock nodes.
        }
        return false;
      };

      const isExcludedElement = (el) => {
        if (!el) return false;
        if (typeof el.closest === 'function') {
          try {
            if (el.closest(excludeSelector)) return true;
          } catch {
            // Ignore selector errors on minimal DOM shims.
          }
        }
        let cur = el;
        while (cur) {
          const tag = String(cur.tagName || '').toLowerCase();
          if (tag === 'textarea' || tag === 'input' || tag === 'script' || tag === 'style' || tag === 'noscript') {
            return true;
          }
          if (cur.isContentEditable) return true;
          const ce = typeof cur.getAttribute === 'function' ? cur.getAttribute('contenteditable') : null;
          if (ce === 'true' || ce === '') return true;
          if (tag === 'article' && typeof cur.getAttribute === 'function' && cur.getAttribute('data-testid') === 'tweet') {
            return true;
          }
          if (isHiddenElement(cur)) return true;
          cur = cur.parentElement;
        }
        return false;
      };

      const walker = document.createTreeWalker(document.body, SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement || node.parentNode;
          if (!parent || isExcludedElement(parent)) return FILTER_SKIP;
          return FILTER_ACCEPT;
        },
      });

      const chunks = [];
      let current;
      while ((current = walker.nextNode()) !== null) {
        const val = String(current.nodeValue || '').trim();
        if (val) chunks.push(val);
      }
      return chunks.join('\n');
    }, GUARD_TEXT_EXCLUDE_SELECTOR);
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/**
 * Read visible innerText from the active document safely (works with real CDP and minimal mocks).
 *
 * @param {object} page
 * @returns {Promise<string>}
 */
export async function readPageText(page) {
  if (!page || typeof page.evaluate !== 'function') return '';
  try {
    const text = await page.evaluate(() => {
      if (typeof document === 'undefined' || !document.body) return '';
      return document.body.innerText || document.body.textContent || '';
    });
    return typeof text === 'string' ? text : '';
  } catch {
    return '';
  }
}

/**
 * Safely query selectors via `page.queryAny`, normalizing null/undefined mock responses.
 *
 * @param {object} page
 * @param {string[]} selectors
 * @returns {Promise<{ selector: string | null, found: boolean, visible: boolean, text: string, disabled: boolean }>}
 */
export async function safeQueryAny(page, selectors) {
  if (!page || typeof page.queryAny !== 'function' || !Array.isArray(selectors) || selectors.length === 0) {
    return { selector: null, found: false, visible: false, text: '', disabled: false };
  }
  try {
    const res = await page.queryAny(selectors);
    if (!res || typeof res !== 'object') {
      return { selector: null, found: false, visible: false, text: '', disabled: false };
    }
    return {
      selector: res.selector ?? null,
      found: Boolean(res.found),
      visible: res.visible !== undefined ? Boolean(res.visible) : Boolean(res.found),
      text: typeof res.text === 'string' ? res.text : '',
      disabled: Boolean(res.disabled),
    };
  } catch {
    return { selector: null, found: false, visible: false, text: '', disabled: false };
  }
}

/**
 * Capture a stage screenshot if `screenshotDir` is provided. Never throws.
 *
 * @param {object} page
 * @param {string | null | undefined} screenshotDir
 * @param {string} platform
 * @param {string} stage
 * @param {Record<string, unknown>} [diagnostics]
 * @returns {Promise<string | null>}
 */
export async function captureScreenshot(page, screenshotDir, platform, stage, diagnostics = null) {
  if (!page || typeof page.screenshot !== 'function' || !screenshotDir) return null;
  const safeStage = String(stage || 'state').replace(/[^a-z0-9_-]/gi, '_');
  const filePath = path.join(screenshotDir, `${platform}-${safeStage}-${Date.now()}.png`);
  try {
    const saved = await page.screenshot(filePath);
    return typeof saved === 'string' && saved.length > 0 ? saved : filePath;
  } catch (err) {
    if (diagnostics && typeof diagnostics === 'object') {
      diagnostics.screenshotError = err instanceof Error ? err.message : String(err);
    }
    return null;
  }
}

/**
 * Emit structured progress updates to `ctx.onProgress(stage, message)` if provided.
 *
 * @param {object} ctx
 * @param {string} _platform
 * @param {string} stage
 * @param {string} message
 */
export function reportProgress(ctx, _platform, stage, message) {
  if (ctx && typeof ctx.onProgress === 'function') {
    try {
      ctx.onProgress(stage, message);
    } catch {
      // Never allow progress observer errors to break adapter execution.
    }
  }
}

/**
 * Click by CSS selectors first via `page.clickAny`, falling back to a strictly read-only
 * 2-pass text lookup (semantic interactive elements first, then deepest non-wrapper span/div)
 * that returns the element's bounding rect and clicks via `page.clickPoint(rect)` with ZERO DOM mutation.
 *
 * @param {object} page
 * @param {string[]} selectors
 * @param {string[]} textLabels
 * @param {{ timeoutMs?: number, exact?: boolean }} [opts]
 * @returns {Promise<{ clicked: boolean, selector: string | null, via: 'css' | 'text' | null }>}
 */
export async function clickWithTextFallback(page, selectors, textLabels = [], opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const exact = opts.exact ?? false;

  if (Array.isArray(selectors) && selectors.length > 0 && typeof page.clickAny === 'function') {
    try {
      const hit = await page.clickAny(selectors, { timeoutMs });
      if (hit && hit.selector) {
        return { clicked: true, selector: hit.selector, via: 'css' };
      }
      if (hit !== undefined && hit !== null) {
        return { clicked: true, selector: selectors[0], via: 'css' };
      }
    } catch {
      // Fall through to text label lookup.
    }
  }

  if (Array.isArray(textLabels) && textLabels.length > 0 && typeof page.evaluate === 'function') {
    try {
      const match = await page.evaluate(
        (labels, isExact) => {
          if (typeof document === 'undefined') return null;

          const INTERACTIVE_SELECTOR =
            'button, a, [role="button"], [role="tab"], [role="radio"], [role="menuitem"], label';
          const FALLBACK_SELECTOR = 'span, div';

          const isElementVisible = (el) => {
            const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
            if (!rect || rect.width <= 0 || rect.height <= 0) return false;
            const style = typeof getComputedStyle === 'function' ? getComputedStyle(el) : null;
            if (style && (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0')) {
              return false;
            }
            return true;
          };

          const getText = (el) => (el.innerText || el.textContent || '').trim();

          const matchesTarget = (txt, target) => {
            if (!txt || txt.length > 60) return false;
            return isExact ? txt === target : txt === target || txt.includes(target);
          };

          const getDomDepth = (el) => {
            let depth = 0;
            let cur = el;
            while (cur && cur.parentElement) {
              depth += 1;
              cur = cur.parentElement;
            }
            return depth;
          };

          const pickBestInPass = (selector, target) => {
            const nodes = Array.from(document.querySelectorAll(selector));
            const matched = [];
            for (const el of nodes) {
              if (!isElementVisible(el)) continue;
              const txt = getText(el);
              if (!matchesTarget(txt, target)) continue;
              matched.push({ el, txt, exact: txt === target, depth: getDomDepth(el) });
            }
            if (matched.length === 0) return null;

            // Reject any outer wrapper whose descendant also matched in this pass.
            const leafMatches = matched.filter(
              (cand) => !matched.some((other) => other.el !== cand.el && cand.el.contains(other.el))
            );
            const pool = leafMatches.length > 0 ? leafMatches : matched;

            pool.sort((a, b) => {
              if (a.exact !== b.exact) return a.exact ? -1 : 1;
              if (a.txt.length !== b.txt.length) return a.txt.length - b.txt.length;
              return b.depth - a.depth;
            });
            return pool[0];
          };

          for (const label of labels) {
            const target = String(label).trim();
            if (!target) continue;

            // Pass 1: semantic interactive elements first
            let best = pickBestInPass(INTERACTIVE_SELECTOR, target);
            // Pass 2: deepest non-wrapper span/div fallback only if no interactive element matched
            if (!best) {
              best = pickBestInPass(FALLBACK_SELECTOR, target);
            }
            if (!best) continue;

            const clickable = best.el.closest(INTERACTIVE_SELECTOR) || best.el;
            let rect = clickable.getBoundingClientRect ? clickable.getBoundingClientRect() : null;
            if (!rect || rect.width <= 0 || rect.height <= 0) continue;

            const vh = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 900;
            const vw = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1440;
            const outOfView = rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw;
            if (outOfView && typeof clickable.scrollIntoView === 'function') {
              try {
                clickable.scrollIntoView({ block: 'center', inline: 'center' });
                rect = clickable.getBoundingClientRect();
              } catch {
                // Ignore scroll errors.
              }
            }

            return {
              found: true,
              text: best.txt,
              rect: {
                x: rect.left,
                y: rect.top,
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
              },
            };
          }
          return null;
        },
        textLabels,
        exact
      );

      if (match && match.found && match.rect) {
        if (typeof page.clickPoint === 'function') {
          await page.clickPoint(match.rect);
        } else {
          // Lightweight mock fallback when page lacks `clickPoint`: re-locate read-only and click directly.
          await page.evaluate(
            (targetText, isExact) => {
              if (typeof document === 'undefined') return false;
              const INTERACTIVE_SELECTOR =
                'button, a, [role="button"], [role="tab"], [role="radio"], [role="menuitem"], label';
              const FALLBACK_SELECTOR = 'span, div';
              const getText = (el) => (el.innerText || el.textContent || '').trim();
              const isVisible = (el) => {
                const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
                return Boolean(r && r.width > 0 && r.height > 0);
              };
              const findMatch = (selector) => {
                const nodes = Array.from(document.querySelectorAll(selector)).filter((el) => {
                  if (!isVisible(el)) return false;
                  const txt = getText(el);
                  return isExact ? txt === targetText : txt === targetText || txt.includes(targetText);
                });
                const leaves = nodes.filter((el) => !nodes.some((other) => other !== el && el.contains(other)));
                return (leaves.length ? leaves : nodes)[0] || null;
              };
              const el = findMatch(INTERACTIVE_SELECTOR) || findMatch(FALLBACK_SELECTOR);
              const clickable = el ? (el.closest(INTERACTIVE_SELECTOR) || el) : null;
              if (clickable && typeof clickable.click === 'function') {
                clickable.click();
                return true;
              }
              return false;
            },
            match.text,
            exact
          );
        }
        return { clicked: true, selector: `text:${match.text}`, via: 'text' };
      }
    } catch {
      // Ignore evaluation fallback errors.
    }
  }

  return { clicked: false, selector: null, via: null };
}

/**
 * Common media/mode validation shared across all platform adapters.
 *
 * @param {object} payload
 * @param {object} spec
 * @param {string[]} errors
 * @param {string[]} warnings
 */
export function validateCommonMedia(payload, spec, errors, warnings) {
  if (!payload || typeof payload !== 'object') {
    errors.push('发布参数 payload 不能为空');
    return;
  }

  if (!payload.videoPath || typeof payload.videoPath !== 'string' || !payload.videoPath.trim()) {
    errors.push('缺少视频文件路径 videoPath');
  }

  if (payload.mode != null && payload.mode !== 'draft' && payload.mode !== 'publish') {
    errors.push(`不支持的发布模式 mode="${payload.mode}"，仅允许 "draft" 或 "publish"`);
  }

  const mediaInfo = payload.mediaInfo || payload.options?.mediaInfo;
  const sizeMb =
    typeof payload.videoSizeMb === 'number'
      ? payload.videoSizeMb
      : typeof mediaInfo?.sizeMb === 'number'
        ? mediaInfo.sizeMb
        : typeof mediaInfo?.sizeBytes === 'number'
          ? mediaInfo.sizeBytes / (1024 * 1024)
          : null;

  const durationSec =
    typeof payload.durationSec === 'number'
      ? payload.durationSec
      : typeof mediaInfo?.durationSec === 'number'
        ? mediaInfo.durationSec
        : null;

  if (sizeMb != null && Number.isFinite(sizeMb) && spec.limits.maxFileSizeMb > 0 && sizeMb > spec.limits.maxFileSizeMb) {
    errors.push(
      `${spec.name}单条视频大小上限为 ${spec.limits.maxFileSizeMb} MB，当前文件约 ${sizeMb.toFixed(1)} MB`
    );
  }

  if (
    durationSec != null &&
    Number.isFinite(durationSec) &&
    spec.limits.maxDurationSec > 0 &&
    durationSec > spec.limits.maxDurationSec
  ) {
    if (spec.id === 'x' && payload.options?.xPremium) {
      warnings.push(
        `当前视频时长约 ${Math.round(durationSec)}s，已超出标准 X 账号 ${spec.limits.maxDurationSec}s 上限（已声明 xPremium，请确认账号支持长视频）`
      );
    } else {
      errors.push(
        `${spec.name}视频时长上限为 ${spec.limits.maxDurationSec} 秒，当前视频约 ${Math.round(durationSec)} 秒`
      );
    }
  }

  if (payload.coverPath && !spec.capabilities.cover) {
    warnings.push(`${spec.name}网页发布器不支持自定义视频封面，已忽略 coverPath`);
  }
}
