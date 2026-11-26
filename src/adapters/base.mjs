import path from 'node:path';

/**
 * Shared helpers for clean-room social video publishing adapters.
 * Pure Node ESM stdlib only (zero third-party dependencies).
 */

const VERIFICATION_PATTERNS = Object.freeze([
  // SMS / Phone verification (Douyin, XHS, Bilibili, X)
  { kind: 'sms', regex: /接收短信验证码|获取短信验证码|输入短信验证码|发送短信验证码|短信验证|语音验证码|请输入验证码|手机号验证|验证手机号|绑定手机验证/i },
  { kind: 'sms', regex: /verify your phone|enter the verification code|confirmation code|sms verification|enter the code we sent/i },
  // Slider / Puzzle captcha
  { kind: 'slider', regex: /拖动滑块|向右滑动完成验证|向右拖动滑块|滑动拼图|拼图验证|滑块验证|拖动下方滑块|按住左边滑块|请拖动滑块/i },
  { kind: 'slider', regex: /slide to verify|complete the puzzle|drag the slider/i },
  // Image / Click / Anti-bot captcha
  { kind: 'captcha', regex: /依次点击|点击图中|图形验证码|人机验证|行为验证|请完成安全验证|安全风控验证|完成下方验证/i },
  { kind: 'captcha', regex: /verify you are human|prove you are not a robot|arkose|funcaptcha|captcha/i },
  // Account security challenge
  { kind: 'security_check', regex: /账号存在安全风险|环境异常.*验证|请进行安全验证|身份验证以继续|账号保护验证/i },
  { kind: 'security_check', regex: /suspicious login prevented|unusual login activity|challenge required|confirm your identity|authenticate your account/i },
]);

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
  const safeMin = Number.isFinite(minMs) ? Math.max(0, Math.floor(minMs)) : 150;
  const safeMax = Number.isFinite(maxMs) ? Math.max(0, Math.floor(maxMs)) : Math.max(safeMin, 450);
  const low = Math.min(safeMin, safeMax);
  const high = Math.max(safeMin, safeMax);
  const delayMs = low === high ? low : low + Math.floor(Math.random() * (high - low + 1));

  if (page && typeof page.sleep === 'function') {
    await page.sleep(delayMs);
  } else {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return delayMs;
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
 * Detect SMS / phone / captcha / slider / security verification modals from visible page text.
 *
 * @param {unknown} pageText
 * @returns {{ detected: boolean, kind: 'sms' | 'slider' | 'captcha' | 'security_check' | null, matched: string | null }}
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
 * Click by CSS selectors first via `page.clickAny`, falling back to matching a visible
 * interactive element by text labels via `page.evaluate` + real CDP click.
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
    const marker = `svp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    try {
      const foundLabel = await page.evaluate(
        (labels, mark, isExact) => {
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
            clickable.setAttribute('data-svp-click', mark);
            return best.txt;
          }
          return null;
        },
        textLabels,
        marker,
        exact
      );

      if (foundLabel) {
        const markerSelector = `[data-svp-click="${marker}"]`;
        try {
          if (typeof page.clickAny === 'function') {
            await page.clickAny([markerSelector], { timeoutMs: 2000 });
          } else {
            await page.evaluate((sel) => {
              const node = document.querySelector(sel);
              if (node && typeof node.click === 'function') node.click();
            }, markerSelector);
          }
        } finally {
          await page
            .evaluate((sel) => {
              const node = document.querySelector(sel);
              if (node) node.removeAttribute('data-svp-click');
            }, markerSelector)
            .catch(() => {});
        }
        return { clicked: true, selector: `text:${foundLabel}`, via: 'text' };
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
