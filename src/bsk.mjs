import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import {
  enrichedPath,
  redactSensitiveText,
} from './constants.mjs';
import {
  humanSleep,
  jitterDelay,
  randInt,
  sampleInteriorPoint,
} from './human.mjs';
import { IN_PAGE_FINDER_SOURCE } from './cdp.mjs';

const DEFAULT_BSK_TIMEOUT_SEC = 30;
const CHILD_TIMEOUT_GRACE_MS = 5_000;
const MAX_EXEC_BUFFER = 32 * 1024 * 1024;
const PAUSE_PUNCT_END_RE = /[，。！？；：、…—,.!?;:\n]$/;

/**
 * Exact set of `bsk 0.5.0` subcommands that accept `--timeout <dur>`.
 * Subcommands such as `browsers`, `session start/stop`, `tab list/create/close`,
 * and `sync` (which only accepts `--timeout-ms`) MUST NOT receive `--timeout`.
 */
const TIMEOUT_SUPPORTED_COMMANDS = Object.freeze(new Set([
  'evaluate',
  'navigate',
  'click',
  'hover',
  'scroll-to',
  'focus',
  'wheel',
  'fill',
  'press',
  'upload',
  'screenshot',
]));

const RESYNC_REASONS = Object.freeze(new Set([
  'cooperation_sync_required',
  'control_context_invalid',
  'observation_required',
  'document_changed',
]));

function isDocumentChangedError(err) {
  if (!err) return false;
  if (err.reason === 'document_changed') return true;
  return /document changed during observation|observe again/i.test(String(err.message || ''));
}

const KEY_NAME_MAP = Object.freeze({
  ' ': 'Space',
  '\n': 'Enter',
  '\r': 'Enter',
  '\t': 'Tab',
});

/**
 * Structured error surfaced by `runBsk()` for non-zero CLI exits or transport failures.
 */
export class BskError extends Error {
  constructor({ exitCode = 1, reason = '', retryAfterMs = 0, message = '', raw = null, data = null } = {}) {
    const cleanMsg = redactSensitiveText(message || reason || `bsk exited with code ${exitCode}`);
    super(cleanMsg);
    this.name = 'BskError';
    this.exitCode = Number.isFinite(Number(exitCode)) ? Number(exitCode) : 1;
    this.reason = String(reason || '').trim();
    this.retryAfterMs = Number.isFinite(Number(retryAfterMs)) && Number(retryAfterMs) > 0
      ? Math.round(Number(retryAfterMs))
      : 0;
    this.raw = raw;
    this.data = data;
  }
}

function normalizeSelectors(selectors) {
  if (Array.isArray(selectors)) return selectors.map((s) => String(s || '').trim()).filter(Boolean);
  const one = String(selectors || '').trim();
  return one ? [one] : [];
}

function parseDurationToSeconds(raw, fallbackSec = DEFAULT_BSK_TIMEOUT_SEC) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return fallbackSec;
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
  if (!match) return fallbackSec;
  const val = Number(match[1]);
  if (!Number.isFinite(val) || val <= 0) return fallbackSec;
  const unit = match[2] || 's';
  if (unit === 'ms') return Math.max(1, Math.ceil(val / 1000));
  if (unit === 'm') return Math.ceil(val * 60);
  if (unit === 'h') return Math.ceil(val * 3600);
  return Math.ceil(val);
}

function extractExplicitTimeoutSec(args) {
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] || '');
    if (token === '--') break;
    if (token === '--timeout' && i + 1 < args.length) {
      return parseDurationToSeconds(args[i + 1], null);
    }
    if (token.startsWith('--timeout=')) {
      return parseDurationToSeconds(token.slice('--timeout='.length), null);
    }
  }
  return null;
}

function hasFlagBeforeDoubleDash(args, flag) {
  for (let i = 0; i < args.length; i += 1) {
    const token = String(args[i] || '');
    if (token === '--') break;
    if (token === flag || token.startsWith(`${flag}=`)) return true;
  }
  return false;
}

function insertBeforeDoubleDash(args, extraTokens) {
  const ddIdx = args.indexOf('--');
  if (ddIdx === -1) {
    return [...args, ...extraTokens];
  }
  return [...args.slice(0, ddIdx), ...extraTokens, ...args.slice(ddIdx)];
}

function parseBskJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fallback: try parsing last JSON line or outermost JSON object/array slice.
  }
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if ((line.startsWith('{') && line.endsWith('}')) || (line.startsWith('[') && line.endsWith(']'))) {
      try {
        return JSON.parse(line);
      } catch {
        // continue
      }
    }
  }
  const firstObj = trimmed.indexOf('{');
  const firstArr = trimmed.indexOf('[');
  const candidates = [];
  if (firstObj !== -1) {
    const lastObj = trimmed.lastIndexOf('}');
    if (lastObj > firstObj) candidates.push({ start: firstObj, end: lastObj + 1 });
  }
  if (firstArr !== -1) {
    const lastArr = trimmed.lastIndexOf(']');
    if (lastArr > firstArr) candidates.push({ start: firstArr, end: lastArr + 1 });
  }
  candidates.sort((a, b) => a.start - b.start);
  for (const { start, end } of candidates) {
    try {
      return JSON.parse(trimmed.slice(start, end));
    } catch {
      // try next candidate
    }
  }
  return null;
}

function invokeExecFile(impl, file, args, options) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, stdout, stderr) => {
      if (settled) return;
      settled = true;
      if (err) {
        if (err.stdout === undefined) err.stdout = stdout ?? '';
        if (err.stderr === undefined) err.stderr = stderr ?? '';
        reject(err);
        return;
      }
      resolve({
        stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
        stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
      });
    };

    try {
      const ret = impl(file, args, options, done);
      if (ret && typeof ret.then === 'function') {
        ret.then(
          (res) => {
            if (settled) return;
            settled = true;
            if (typeof res === 'string') {
              resolve({ stdout: res, stderr: '' });
            } else {
              resolve({
                stdout: typeof res?.stdout === 'string' ? res.stdout : String(res?.stdout ?? ''),
                stderr: typeof res?.stderr === 'string' ? res.stderr : String(res?.stderr ?? ''),
              });
            }
          },
          (err) => {
            if (settled) return;
            settled = true;
            reject(err);
          },
        );
      }
    } catch (err) {
      if (!settled) {
        settled = true;
        reject(err);
      }
    }
  });
}

function isExecutableFile(filePath, platform = process.platform) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (platform !== 'win32') {
      fs.accessSync(filePath, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Locates the `bsk` CLI executable on an enriched PATH
 * (including `~/.local/bin/bsk`, `/opt/homebrew/bin/bsk`, `/usr/local/bin/bsk`).
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string }} [opts]
 * @returns {string | null}
 */
export function findBskExecutable({ env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const explicit = String(env.SOCIAL_PUB_BSK_BIN || env.BSK_BIN || '').trim();
  if (explicit && isExecutableFile(explicit, platform)) {
    return explicit;
  }

  const binName = platform === 'win32' ? 'bsk.exe' : 'bsk';
  const sep = platform === 'win32' ? ';' : ':';
  const pathDirs = enrichedPath(env, platform, home).split(sep).filter(Boolean);
  const priorityDirs = platform === 'win32'
    ? pathDirs
    : [
        ...pathDirs,
        path.join(home, '.local', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
      ];

  const seen = new Set();
  for (const dir of priorityDirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, binName);
    if (isExecutableFile(candidate, platform)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Executes `bsk` directly via `execFile` (never a shell), ensuring:
 * - explicit `--timeout <Ns>` on commands that accept `--timeout`
 * - Node child timeout = `(effectiveBskTimeoutSec + 5) * 1000` to prevent `session_busy` locks
 * - clean `--json` parsing and structured `BskError` on failure
 *
 * @param {string[]} args
 * @param {{
 *   bskBin?: string,
 *   bskTimeoutSec?: number,
 *   env?: NodeJS.ProcessEnv,
 *   execFileImpl?: Function,
 * }} [opts]
 * @returns {Promise<any>}
 */
export async function runBsk(
  args,
  {
    bskBin = '',
    bskTimeoutSec = DEFAULT_BSK_TIMEOUT_SEC,
    env = process.env,
    execFileImpl = execFile,
  } = {},
) {
  const bin = bskBin || findBskExecutable({ env });
  if (!bin) {
    throw new BskError({
      exitCode: 127,
      reason: 'bsk_not_found',
      message: '未找到 bsk 可执行文件（已检查 PATH、~/.local/bin、/opt/homebrew/bin、/usr/local/bin）',
    });
  }

  let finalArgs = Array.isArray(args) ? args.map((a) => String(a)) : [];
  const primaryCmd = String(finalArgs[0] || '').trim();
  const explicitTimeoutSec = extractExplicitTimeoutSec(finalArgs);
  const requestedTimeoutSec = Math.max(1, Math.ceil(Number(bskTimeoutSec) || DEFAULT_BSK_TIMEOUT_SEC));
  const effectiveTimeoutSec = explicitTimeoutSec ?? requestedTimeoutSec;

  if (TIMEOUT_SUPPORTED_COMMANDS.has(primaryCmd) && explicitTimeoutSec === null) {
    finalArgs = insertBeforeDoubleDash(finalArgs, ['--timeout', `${effectiveTimeoutSec}s`]);
  }
  if (!hasFlagBeforeDoubleDash(finalArgs, '--json')) {
    finalArgs = insertBeforeDoubleDash(finalArgs, ['--json']);
  }

  const nodeTimeoutMs = (effectiveTimeoutSec + 5) * 1000;
  const execOpts = {
    timeout: Math.max(nodeTimeoutMs, CHILD_TIMEOUT_GRACE_MS + 1000),
    maxBuffer: MAX_EXEC_BUFFER,
    env: { ...env, PATH: enrichedPath(env) },
    windowsHide: true,
  };

  try {
    const { stdout, stderr } = await invokeExecFile(execFileImpl, bin, finalArgs, execOpts);
    const parsed = parseBskJson(stdout);
    if (parsed !== null) {
      return parsed;
    }
    const trimmedOut = String(stdout || '').trim();
    if (!trimmedOut) return {};
    throw new BskError({
      exitCode: 0,
      reason: 'invalid_json',
      message: `bsk 返回了非 JSON 输出：${trimmedOut.slice(0, 300)}`,
      raw: { stdout, stderr },
    });
  } catch (err) {
    if (err instanceof BskError) throw err;

    const stdout = typeof err?.stdout === 'string' ? err.stdout : String(err?.stdout ?? '');
    const stderr = typeof err?.stderr === 'string' ? err.stderr : String(err?.stderr ?? '');
    const parsed = parseBskJson(stdout) || parseBskJson(stderr);
    const numericCode = typeof err?.code === 'number'
      ? err.code
      : (typeof err?.exitCode === 'number' ? err.exitCode : (err?.killed ? 124 : 1));
    const data = parsed && typeof parsed.data === 'object' ? parsed.data : null;

    let reason = String(data?.reason || parsed?.reason || '').trim();
    if (!reason) {
      if (err?.code === 'ENOENT') reason = 'bsk_not_found';
      else if (err?.killed || err?.signal === 'SIGTERM') reason = 'child_timeout';
      else if (numericCode === 2) reason = 'daemon_unreachable';
      else if (numericCode === 4) reason = 'timeout';
      else if (numericCode === 5) reason = 'version_skew';
    }

    const retryAfterMs = Number(data?.retry_after_ms ?? parsed?.retry_after_ms ?? 0) || 0;
    const rawMsg =
      (typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message || parsed?.error?.text) ||
      parsed?.error_text ||
      data?.error_text ||
      parsed?.message ||
      stderr.trim() ||
      stdout.trim() ||
      (err instanceof Error ? err.message : String(err));

    throw new BskError({
      exitCode: numericCode,
      reason,
      retryAfterMs,
      message: rawMsg,
      raw: { stdout, stderr, parsed },
      data,
    });
  }
}

/**
 * Probes whether `bsk` and a healthy connected browser instance are available.
 * Browser selection priority:
 *   explicit `browserId` -> `env.BSK_BROWSER_ID` -> `env.SOCIAL_PUB_BSK_BROWSER` -> first `!unresponsive && !version_skew`
 *
 * @param {{
 *   browserId?: string,
 *   env?: NodeJS.ProcessEnv,
 *   execFileImpl?: Function,
 *   bskBin?: string,
 * }} [opts]
 */
export async function probeBskAvailable({
  browserId = '',
  env = process.env,
  execFileImpl = execFile,
  bskBin = '',
} = {}) {
  const bin = bskBin || findBskExecutable({ env });
  if (!bin) {
    return { available: false, reason: 'bsk_not_found' };
  }

  let raw;
  try {
    raw = await runBsk(['browsers', '--json'], {
      bskBin: bin,
      bskTimeoutSec: 8,
      env,
      execFileImpl,
    });
  } catch (err) {
    return {
      available: false,
      reason: (err instanceof BskError && err.reason) ? err.reason : 'bsk_probe_failed',
      message: redactSensitiveText(err instanceof Error ? err.message : String(err)),
    };
  }

  const browsers = Array.isArray(raw)
    ? raw
    : (Array.isArray(raw?.browsers) ? raw.browsers : []);

  if (!browsers.length) {
    return { available: false, reason: 'no_connected_browsers' };
  }

  const preferred = String(
    browserId || env.BSK_BROWSER_ID || env.SOCIAL_PUB_BSK_BROWSER || '',
  ).trim();

  let selected = null;
  if (preferred) {
    const lowerPref = preferred.toLowerCase();
    selected = browsers.find((b) => String(b?.instance_id || '') === preferred || String(b?.label || '') === preferred)
      || browsers.find((b) => String(b?.label || '').toLowerCase() === lowerPref)
      || null;
    if (!selected) {
      return {
        available: false,
        reason: 'requested_browser_not_found',
        message: `未找到指定的 bsk 浏览器实例：${preferred}`,
      };
    }
    if (selected.unresponsive) {
      return {
        available: false,
        reason: 'browser_unresponsive',
        message: `指定的 bsk 浏览器无响应：${preferred}`,
      };
    }
    if (selected.version_skew) {
      return {
        available: false,
        reason: 'version_skew',
        message: `指定的 bsk 浏览器扩展版本不匹配：${preferred}`,
      };
    }
  } else {
    selected = browsers.find((b) => b && !b.unresponsive && !b.version_skew) || null;
    if (!selected) {
      const hasSkew = browsers.some((b) => b && b.version_skew);
      return {
        available: false,
        reason: hasSkew ? 'version_skew' : 'browser_unresponsive',
      };
    }
  }

  return {
    available: true,
    bskBin: bin,
    browser: {
      instance_id: String(selected.instance_id),
      label: String(selected.label || ''),
      browser_name: String(selected.browser_name || ''),
      browser_version: String(selected.browser_version || ''),
      extension_version: String(selected.extension_version || ''),
    },
  };
}

/**
 * Strictly read-only unique CSS path builder injected inside `bsk evaluate --unverified`.
 * Produces a verified `#id` or `tag:nth-of-type(k)` chain in the main document
 * (`document.querySelector(path) === el`) with ZERO DOM mutations.
 * Returns `null` when the element lives inside a ShadowRoot or iframe.
 */
export const BUILD_UNIQUE_CSS_PATH_SOURCE = `
function __svBuildUniqueCssPath(el) {
  if (!el || el.nodeType !== 1) return null;
  if (el.ownerDocument !== document) return null;
  if (typeof el.getRootNode === 'function' && el.getRootNode() !== document) return null;

  function escapeIdent(raw) {
    const str = String(raw || '');
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(str);
    }
    return str.replace(/([^a-zA-Z0-9_-])/g, '\\\\$1');
  }

  function isUnique(selector) {
    if (!selector) return false;
    try {
      return document.querySelector(selector) === el;
    } catch (_) {
      return false;
    }
  }

  if (el.id) {
    const byId = '#' + escapeIdent(el.id);
    if (isUnique(byId)) return byId;
  }

  const parts = [];
  let cur = el;
  while (cur && cur.nodeType === 1) {
    const tag = String(cur.tagName || '').toLowerCase();
    if (!tag) return null;
    if (tag === 'html') {
      parts.unshift('html');
      break;
    }
    if (cur.id) {
      const idAnchor = '#' + escapeIdent(cur.id);
      try {
        if (document.querySelectorAll(idAnchor).length === 1) {
          parts.unshift(idAnchor);
          const candidate = parts.join(' > ');
          if (isUnique(candidate)) return candidate;
        }
      } catch (_) {}
    }

    let sameTagCount = 0;
    let index = 1;
    const parent = cur.parentElement;
    if (parent) {
      for (const child of parent.children) {
        if (String(child.tagName || '').toLowerCase() === tag) {
          sameTagCount += 1;
          if (child === cur) index = sameTagCount;
        }
      }
    }
    const seg = sameTagCount > 1 ? (tag + ':nth-of-type(' + index + ')') : tag;
    parts.unshift(seg);

    const candidate = parts.join(' > ');
    if (isUnique(candidate)) return candidate;

    if (tag === 'body') break;
    cur = parent;
  }

  const fullPath = parts.join(' > ');
  return isUnique(fullPath) ? fullPath : null;
}
`;

function modifiersToString(modifiers = 0) {
  if (typeof modifiers === 'string') return modifiers.trim();
  const mask = Number(modifiers) || 0;
  if (!mask) return '';
  const list = [];
  if (mask & 1) list.push('alt');
  if (mask & 2) list.push('ctrl');
  if (mask & 4) list.push('meta');
  if (mask & 8) list.push('shift');
  return list.join(',');
}

function normalizePressKeyName(rawKey) {
  const s = String(rawKey ?? '');
  if (Object.prototype.hasOwnProperty.call(KEY_NAME_MAP, s)) {
    return KEY_NAME_MAP[s];
  }
  return s;
}

/**
 * Splits text into natural 2–6 code-point chunks, breaking early at punctuation or
 * newlines so `BskPage.fillText` pauses naturally without spawning 1 CLI per ASCII char.
 *
 * @param {string} text
 * @param {() => number} [rng=Math.random]
 * @returns {Array<{ text: string, pauseAfter: boolean }>}
 */
export function splitHumanChunks(text, rng = Math.random) {
  const chars = Array.from(String(text ?? ''));
  if (!chars.length) return [];
  const chunks = [];
  let idx = 0;
  while (idx < chars.length) {
    const targetLen = randInt(2, 6, rng);
    let buf = '';
    let count = 0;
    let pauseAfter = false;
    while (idx < chars.length && count < targetLen) {
      const ch = chars[idx];
      buf += ch;
      idx += 1;
      count += 1;
      if (PAUSE_PUNCT_END_RE.test(ch)) {
        pauseAfter = true;
        break;
      }
    }
    chunks.push({ text: buf, pauseAfter });
  }
  return chunks;
}

function formatValueFlag(value) {
  const s = String(value ?? '');
  if (s.startsWith('-')) {
    return [`--value=${s}`];
  }
  return ['--value', s];
}

export class BskPage {
  constructor(session, { tabId, fastMode = false, rng = Math.random } = {}) {
    this.session = session;
    this.sessionId = session.sessionId;
    this.tabId = tabId;
    this.targetId = String(tabId);
    this.contextId = null;
    this.observationId = null;
    this.observationUsed = true;
    this.hasNavigated = false;
    this.closed = false;
    this.fastMode = Boolean(fastMode);
    this.rng = typeof rng === 'function' ? rng : Math.random;
  }

  _humanSleep(ms) {
    return humanSleep(ms, { fastMode: this.fastMode });
  }

  async sleep(ms) {
    return this._humanSleep(ms);
  }

  _run(args, opts = {}) {
    return runBsk(args, {
      bskBin: this.session.bskBin,
      env: this.session.env,
      execFileImpl: this.session.execFileImpl,
      ...opts,
    });
  }

  async _sync() {
    let transientRetries = 0;
    while (true) {
      try {
        const res = await this._run(
          ['sync', '--session', this.sessionId, '--tab-id', this.targetId, '--json'],
          { bskTimeoutSec: 15 },
        );
        const nextCtx = res?.context_id || res?.ctx || null;
        const nextObs = res?.observation_id || res?.obs || null;
        if (nextCtx) this.contextId = String(nextCtx);
        if (nextObs) this.observationId = String(nextObs);
        this.observationUsed = false;
        return res;
      } catch (err) {
        const isTransient = err?.reason === 'operation_settling' || isDocumentChangedError(err);
        if (isTransient && transientRetries < 3) {
          transientRetries += 1;
          const waitMs = Math.min(5_000, Math.max(150, Number(err?.retryAfterMs) || 450));
          await this._humanSleep(waitMs);
          continue;
        }
        throw err;
      }
    }
  }

  async _ensureContext() {
    if (!this.contextId) {
      await this._sync();
    }
    return this.contextId;
  }

  async _ensureFreshObservation() {
    if (!this.contextId || !this.observationId || this.observationUsed) {
      await this._sync();
    }
    this.observationUsed = true;
    return {
      contextId: this.contextId,
      observationId: this.observationId,
    };
  }

  async _withResync(fn) {
    let settlingRetries = 0;
    let resyncRetries = 0;
    while (true) {
      try {
        return await fn();
      } catch (err) {
        const reason = err?.reason || '';
        if (reason === 'operation_settling' && settlingRetries < 1) {
          settlingRetries += 1;
          const waitMs = Math.min(5_000, Math.max(100, Number(err?.retryAfterMs) || 400));
          await this._humanSleep(waitMs);
          continue;
        }
        if ((RESYNC_REASONS.has(reason) || isDocumentChangedError(err)) && resyncRetries < 2) {
          resyncRetries += 1;
          this.contextId = null;
          this.observationId = null;
          this.observationUsed = true;
          if (isDocumentChangedError(err)) {
            await this._humanSleep(450);
          }
          await this._sync();
          continue;
        }
        throw err;
      }
    }
  }

  async _getViewportInfo() {
    try {
      const info = await this.evaluate(() => ({
        width: window.innerWidth || 1440,
        height: window.innerHeight || 900,
        scrollY: window.scrollY || window.pageYOffset || 0,
      }));
      if (info && Number.isFinite(info.width) && Number.isFinite(info.height)) {
        return info;
      }
    } catch {
      // Fallback to standard viewport dimensions.
    }
    return { width: 1440, height: 900, scrollY: 0 };
  }

  async _resolveElementTarget(selectors, { preferVisible = true } = {}) {
    const list = normalizeSelectors(selectors);
    if (!list.length) return null;
    const expr = `(() => {
      ${IN_PAGE_FINDER_SOURCE}
      ${BUILD_UNIQUE_CSS_PATH_SOURCE}
      const hit = __svFindElement(${JSON.stringify(list)}, ${Boolean(preferVisible)});
      if (!hit) return null;
      const el = hit.el;
      const rect = el.getBoundingClientRect();
      return {
        selector: hit.selector,
        cssPath: __svBuildUniqueCssPath(el),
        visible: hit.visible,
        disabled: hit.disabled,
        left: hit.offsetX + rect.left,
        top: hit.offsetY + rect.top,
        x: hit.offsetX + rect.left,
        y: hit.offsetY + rect.top,
        width: rect.width,
        height: rect.height,
        tagName: (el.tagName || '').toLowerCase(),
        isContentEditable: Boolean(el.isContentEditable),
      };
    })()`;
    return this.evaluate(expr);
  }

  async _hoverCssPath(cssPath, settleMs) {
    const ms = Math.max(0, Math.round(this.fastMode ? Math.min(settleMs, 10) : settleMs));
    return this._withResync(() => this._run(
      [
        'hover',
        '--selector', cssPath,
        '--settle', `${ms}ms`,
        '--session', this.sessionId,
        '--tab-id', this.targetId,
        '--json',
      ],
      { bskTimeoutSec: 20 },
    ));
  }

  async navigate(url, { timeoutMs = 45_000, waitUntil = 'domcontentloaded' } = {}) {
    const targetUrl = String(url || '').trim();
    if (!targetUrl) throw new Error('navigate 需要有效的 URL');
    const bskTimeoutSec = Math.max(5, Math.ceil((Number(timeoutMs) || 45_000) / 1000));
    const waitPhase = String(waitUntil || 'domcontentloaded').trim() || 'domcontentloaded';

    let res;
    try {
      res = await this._withResync(async () => {
        const args = [
          'navigate',
          targetUrl,
          '--session', this.sessionId,
          '--tab-id', this.targetId,
          '--wait-until', waitPhase,
        ];
        if (this.hasNavigated || this.contextId) {
          const { contextId, observationId } = await this._ensureFreshObservation();
          if (contextId) args.push('--context', contextId);
          if (observationId) args.push('--observation', observationId);
        }
        args.push('--json');
        return this._run(args, { bskTimeoutSec });
      });
    } catch (err) {
      // Soft lifecycle-timeout parity with CdpPage.navigate:
      // SPAs (e.g. Douyin creator studio) may paint on domcontentloaded/firstImagePaint while
      // keeping long-lived beacons open. If the page already committed to a real non-about: URL
      // with no net::ERR_* failure, treat navigation as committed and continue to `_sync()`.
      const parsed = err?.raw?.parsed || null;
      const errData = (parsed && typeof parsed.data === 'object' && parsed.data) || err?.data || null;
      const reached = String(parsed?.reached || errData?.reached || '').trim().toLowerCase();
      const committedUrl = String(
        parsed?.final_url || errData?.final_url || parsed?.url || errData?.url || '',
      ).trim();
      const errText = String(parsed?.error_text || errData?.error_text || err?.message || '');
      const isSoftLifecycleTimeout =
        reached === 'timeout' &&
        Boolean(committedUrl) &&
        !/^about:/i.test(committedUrl) &&
        !/net::ERR_/i.test(errText);

      if (!isSoftLifecycleTimeout) {
        throw err;
      }
      res = { final_url: committedUrl, url: committedUrl, reached: 'timeout' };
    }

    this.hasNavigated = true;
    // Navigation invalidates previous control context; always resync immediately.
    this.contextId = null;
    this.observationId = null;
    this.observationUsed = true;
    await this._sync();

    // Brief settle for SPA hydration.
    await this._humanSleep(randInt(450, 850, this.rng));

    const finalUrl = res?.final_url || res?.url || (await this.url());
    return { url: finalUrl };
  }

  async evaluate(fnOrExpr, ...args) {
    const expression = typeof fnOrExpr === 'function'
      ? `(${fnOrExpr.toString()})(...${JSON.stringify(args)})`
      : String(fnOrExpr);

    const res = await this._withResync(async () => {
      const ctx = await this._ensureContext();
      const cliArgs = [
        'evaluate',
        '--session', this.sessionId,
        '--tab-id', this.targetId,
        '--unverified',
        ...(ctx ? ['--context', ctx] : []),
        '--json',
      ];
      if (expression.startsWith('-')) {
        cliArgs.push('--', expression);
      } else {
        cliArgs.splice(1, 0, expression);
      }
      return this._run(cliArgs, { bskTimeoutSec: 30 });
    });

    if (res && res.ok === false) {
      const errDetail = res.error?.text
        || (typeof res.error === 'string' ? res.error : 'bsk evaluate exception');
      const loc = res.error && Number.isFinite(res.error.line)
        ? ` (line ${res.error.line}${Number.isFinite(res.error.column) ? `:${res.error.column}` : ''})`
        : '';
      throw new Error(redactSensitiveText(`${errDetail}${loc}`));
    }

    return res ? res.value : undefined;
  }

  async url() {
    return this.evaluate(() => window.location.href);
  }

  async title() {
    return this.evaluate(() => document.title);
  }

  async queryAny(selectors) {
    const list = normalizeSelectors(selectors);
    if (!list.length) {
      return { selector: null, found: false, visible: false, text: '', disabled: false };
    }
    const expr = `(() => {
      ${IN_PAGE_FINDER_SOURCE}
      const hit = __svFindElement(${JSON.stringify(list)}, true);
      if (!hit) return { selector: null, found: false, visible: false, text: '', disabled: false };
      const el = hit.el;
      const text = String(el.innerText || el.textContent || el.value || '').trim().slice(0, 500);
      return { selector: hit.selector, found: true, visible: hit.visible, text, disabled: hit.disabled };
    })()`;
    return this.evaluate(expr);
  }

  async waitForAny(selectors, { timeoutMs = 30_000, visible = false, pollMs = 300 } = {}) {
    const list = normalizeSelectors(selectors);
    if (!list.length) throw new Error('waitForAny 需要至少一个选择器');
    const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 30_000);
    while (Date.now() < deadline) {
      const hit = await this.queryAny(list);
      if (hit && hit.found && (!visible || hit.visible)) {
        return { ...hit, found: true };
      }
      await this._humanSleep(jitterDelay(pollMs, 0.25, this.rng));
    }
    throw new Error(`等待页面元素超时（${timeoutMs}ms）：${list.join(' | ')}`);
  }

  async scrollElementIntoView(selectors, initialInfo = null) {
    const list = normalizeSelectors(selectors);
    let info = initialInfo && initialInfo.cssPath
      ? initialInfo
      : (await this._resolveElementTarget(list, { preferVisible: true })) || initialInfo;
    if (!info) return null;

    const vp = await this._getViewportInfo();
    const top = Number.isFinite(info.top) ? info.top : (Number.isFinite(info.y) ? info.y : 0);
    const height = Math.max(1, Number(info.height) || 1);
    const centerY = top + height / 2;
    const inBand = centerY >= vp.height * 0.15 && centerY <= vp.height * 0.80;
    if (inBand) return info;

    if (info.cssPath) {
      try {
        await this._withResync(() => this._run(
          [
            'scroll-to',
            '--selector', info.cssPath,
            '--session', this.sessionId,
            '--tab-id', this.targetId,
            '--json',
          ],
          { bskTimeoutSec: 20 },
        ));
        await this._humanSleep(randInt(140, 280, this.rng));
      } catch {
        // Fallback to chunked wheel scroll on the target selector if scroll-to fails.
        const neededDeltaY = Math.round(centerY - vp.height * 0.45);
        const steps = Math.max(2, Math.min(4, Math.ceil(Math.abs(neededDeltaY) / 240)));
        const perStep = Math.round(neededDeltaY / steps);
        for (let i = 0; i < steps; i += 1) {
          const delta = i === steps - 1 ? neededDeltaY - perStep * (steps - 1) : perStep;
          if (!delta) continue;
          try {
            await this._withResync(() => this._run(
              [
                'wheel',
                '--selector', info.cssPath,
                `--delta-y=${delta}`,
                '--session', this.sessionId,
                '--tab-id', this.targetId,
                '--json',
              ],
              { bskTimeoutSec: 15 },
            ));
          } catch {
            break;
          }
          await this._humanSleep(randInt(55, 130, this.rng));
        }
      }
      return (await this._resolveElementTarget([info.selector], { preferVisible: true })) || info;
    }

    // Fallback for elements inside shadow DOM or same-origin iframe.
    await this.evaluate(
      `(() => {
        ${IN_PAGE_FINDER_SOURCE}
        const hit = __svFindElement(${JSON.stringify([info.selector])}, true);
        if (hit && hit.el && typeof hit.el.scrollIntoView === 'function') {
          try { hit.el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' }); } catch (_) {}
        }
      })()`,
    );
    await this._humanSleep(randInt(220, 400, this.rng));
    return (await this._resolveElementTarget([info.selector], { preferVisible: true })) || info;
  }

  async hoverAny(selectors, { dwellMs } = {}) {
    const list = normalizeSelectors(selectors);
    if (!list.length) return { found: false, selector: null };

    const info = await this._resolveElementTarget(list, { preferVisible: true });
    if (!info || !info.visible || !(info.width > 0) || !(info.height > 0)) {
      return { found: false, selector: null };
    }

    const inView = (await this.scrollElementIntoView([info.selector], info)) || info;
    const dwell = Number.isFinite(dwellMs) ? Math.max(0, Math.round(dwellMs)) : randInt(250, 600, this.rng);

    if (inView.cssPath) {
      const res = await this._hoverCssPath(inView.cssPath, dwell);
      return {
        found: true,
        selector: inView.selector,
        x: Number.isFinite(res?.x) ? res.x : Math.round(inView.left + inView.width / 2),
        y: Number.isFinite(res?.y) ? res.y : Math.round(inView.top + inView.height / 2),
      };
    }

    await this._humanSleep(dwell);
    return {
      found: true,
      selector: inView.selector,
      x: Math.round(inView.left + inView.width / 2),
      y: Math.round(inView.top + inView.height / 2),
    };
  }

  async idleDrift({ steps = 1 } = {}) {
    const count = Math.max(1, Math.min(3, Math.round(Number(steps) || 1)));
    let x = randInt(220, 580, this.rng);
    let y = randInt(140, 320, this.rng);

    for (let i = 0; i < count; i += 1) {
      if (i === 0) {
        try {
          const res = await this._hoverCssPath('body', randInt(60, 140, this.rng));
          if (Number.isFinite(res?.x)) x = res.x;
          if (Number.isFinite(res?.y)) y = res.y;
        } catch {
          // Never fail or click anything during lightweight idle drift.
        }
      }
      await this._humanSleep(randInt(140, 340, this.rng));
    }

    return { x, y, steps: count };
  }

  async clickAny(selectors, { timeoutMs = 15_000 } = {}) {
    const list = normalizeSelectors(selectors);
    if (!list.length) throw new Error('clickAny 需要至少一个选择器');

    const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 15_000);
    let info = null;
    while (Date.now() < deadline) {
      info = await this._resolveElementTarget(list, { preferVisible: true });
      if (info && info.visible && info.width > 0 && info.height > 0) break;
      await this._humanSleep(jitterDelay(250, 0.25, this.rng));
    }
    if (!info || !info.visible || !(info.width > 0) || !(info.height > 0)) {
      throw new Error(`点击失败，未找到元素（${timeoutMs}ms）：${list.join(' | ')}`);
    }

    const inView = (await this.scrollElementIntoView([info.selector], info)) || info;

    if (inView.cssPath) {
      await this._hoverCssPath(inView.cssPath, randInt(90, 220, this.rng));
      await this._withResync(() => this._run(
        [
          'click',
          '--selector', inView.cssPath,
          '--session', this.sessionId,
          '--tab-id', this.targetId,
          '--json',
        ],
        { bskTimeoutSec: 20 },
      ));
      await this._humanSleep(randInt(120, 260, this.rng));
      return { selector: inView.selector };
    }

    // Fallback ONLY when element is inside shadow DOM or same-origin iframe where main-doc CSS path is impossible.
    const clicked = await this.evaluate(
      `(() => {
        ${IN_PAGE_FINDER_SOURCE}
        const hit = __svFindElement(${JSON.stringify([inView.selector])}, true);
        if (!hit || !hit.el || typeof hit.el.click !== 'function') return false;
        hit.el.click();
        return true;
      })()`,
    );
    if (!clicked) {
      throw new Error(`点击失败，无法定位可点击元素：${inView.selector}`);
    }
    await this._humanSleep(randInt(120, 260, this.rng));
    return { selector: inView.selector };
  }

  async clickPoint(rect, { settle = true } = {}) {
    const originX = Number.isFinite(rect?.left) ? rect.left : (Number.isFinite(rect?.x) ? rect.x : NaN);
    const originY = Number.isFinite(rect?.top) ? rect.top : (Number.isFinite(rect?.y) ? rect.y : NaN);
    const width = Number(rect?.width);
    const height = Number(rect?.height);
    if (!rect || !Number.isFinite(originX) || !Number.isFinite(originY) || !(width > 0) || !(height > 0)) {
      throw new Error(`clickPoint 收到无效或零尺寸矩形：${JSON.stringify(rect ?? null)}`);
    }

    const pt = sampleInteriorPoint(
      { left: originX, top: originY, width, height },
      { rng: this.rng },
    );
    const x = Math.max(1, Math.round(pt.x));
    const y = Math.max(1, Math.round(pt.y));

    // Read-only elementFromPoint -> verified unique CSS path (ZERO DOM mutation).
    const hit = await this.evaluate(
      `((px, py) => {
        ${BUILD_UNIQUE_CSS_PATH_SOURCE}
        const el = document.elementFromPoint(px, py);
        if (!el) return { found: false, cssPath: null };
        const cssPath = __svBuildUniqueCssPath(el);
        return { found: true, cssPath };
      })(${JSON.stringify(x)}, ${JSON.stringify(y)})`,
    );

    if (hit && hit.cssPath) {
      await this._hoverCssPath(hit.cssPath, randInt(90, 220, this.rng));
      await this._withResync(() => this._run(
        [
          'click',
          '--selector', hit.cssPath,
          '--session', this.sessionId,
          '--tab-id', this.targetId,
          '--json',
        ],
        { bskTimeoutSec: 20 },
      ));
    } else {
      // Fallback ONLY if shadow DOM / same-origin iframe prevents a main-doc CSS path.
      await this.evaluate(
        `((px, py) => {
          let doc = document;
          let cx = px;
          let cy = py;
          let el = doc.elementFromPoint(cx, cy);
          while (el && el.tagName === 'IFRAME') {
            try {
              const r = el.getBoundingClientRect();
              const fdoc = el.contentDocument;
              if (!fdoc) break;
              cx -= r.left;
              cy -= r.top;
              doc = fdoc;
              el = doc.elementFromPoint(cx, cy);
            } catch (_) {
              break;
            }
          }
          while (el && el.shadowRoot && typeof el.shadowRoot.elementFromPoint === 'function') {
            const inner = el.shadowRoot.elementFromPoint(cx, cy);
            if (!inner || inner === el) break;
            el = inner;
          }
          if (el && typeof el.click === 'function') {
            el.click();
            return true;
          }
          return false;
        })(${JSON.stringify(x)}, ${JSON.stringify(y)})`,
      );
    }

    if (settle) {
      await this._humanSleep(randInt(120, 260, this.rng));
    }

    return { x, y };
  }

  async setFiles(selectors, filePaths, { timeoutMs = 30_000 } = {}) {
    const list = normalizeSelectors(selectors);
    if (!list.length) throw new Error('setFiles 需要至少一个选择器');

    const files = (Array.isArray(filePaths) ? filePaths : [filePaths])
      .map((p) => path.resolve(String(p || '').trim()))
      .filter(Boolean);
    if (!files.length) throw new Error('setFiles 需要至少一个本地文件路径');
    for (const file of files) {
      if (!fs.existsSync(file)) throw new Error(`上传文件不存在：${file}`);
    }

    const fileArgs = files.flatMap((f) => ['--file', f]);
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 30_000);

    while (Date.now() < deadline) {
      const probe = await this.evaluate(
        `(() => {
          ${IN_PAGE_FINDER_SOURCE}
          ${BUILD_UNIQUE_CSS_PATH_SOURCE}
          const hit = __svFindElement(${JSON.stringify(list)}, false);
          if (!hit || !hit.el) return { found: false };
          const el = hit.el;
          const rect = el.getBoundingClientRect();
          const style = el.ownerDocument.defaultView.getComputedStyle(el);
          const hasBox = Boolean(
            style &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
          );
          const cssPath = __svBuildUniqueCssPath(el);

          let labelCssPath = null;
          if (!hasBox && el.ownerDocument === document) {
            const isVis = (node) => {
              if (!node || node.nodeType !== 1) return false;
              const st = window.getComputedStyle(node);
              const r = node.getBoundingClientRect();
              return Boolean(
                st &&
                st.display !== 'none' &&
                st.visibility !== 'hidden' &&
                parseFloat(st.opacity || '1') > 0 &&
                r.width > 0 &&
                r.height > 0
              );
            };
            if (el.id) {
              const escapedId = (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
                ? CSS.escape(el.id)
                : String(el.id).replace(/([^a-zA-Z0-9_-])/g, '\\\\$1');
              try {
                const lbl = document.querySelector('label[for="' + escapedId + '"]');
                if (lbl && isVis(lbl)) labelCssPath = __svBuildUniqueCssPath(lbl);
              } catch (_) {}
            }
            if (!labelCssPath && typeof el.closest === 'function') {
              const parentLabel = el.closest('label');
              if (parentLabel && isVis(parentLabel)) {
                labelCssPath = __svBuildUniqueCssPath(parentLabel);
              }
            }
          }

          return {
            found: true,
            selector: hit.selector,
            cssPath,
            inMainDoc: el.ownerDocument === document && (typeof el.getRootNode !== 'function' || el.getRootNode() === document),
            hasBox,
            labelCssPath,
          };
        })()`,
      );

      if (probe && probe.found) {
        if (!probe.cssPath && !probe.labelCssPath && probe.inMainDoc === false) {
          throw new Error(
            `文件输入框位于同源 iframe 或 Shadow DOM 内（${probe.selector}），无法通过主文档 CSS 选择器直接上传；请先导航至对应 iframe URL`,
          );
        }

        // Case 1: Input has a non-zero box (e.g. opacity:0 overlay) -> upload directly.
        if (probe.hasBox && probe.cssPath) {
          await this._withResync(() => this._run(
            [
              'upload',
              ...fileArgs,
              '--mode', 'input',
              '--selector', probe.cssPath,
              '--session', this.sessionId,
              '--tab-id', this.targetId,
              '--json',
            ],
            { bskTimeoutSec: 120 },
          ));
          return { selector: probe.selector };
        }

        // Case 2: Hidden input with visible associated <label for="..."> trigger -> try label first.
        if (probe.labelCssPath) {
          try {
            await this._withResync(() => this._run(
              [
                'upload',
                ...fileArgs,
                '--mode', 'input',
                '--selector', probe.labelCssPath,
                '--session', this.sessionId,
                '--tab-id', this.targetId,
                '--json',
              ],
              { bskTimeoutSec: 120 },
            ));
            return { selector: probe.selector };
          } catch {
            // Fall through to Case 3 temporary 1x1 box reveal on the exact <input type="file">.
          }
        }

        // Case 3: Hidden display:none or 0x0 input -> temporarily expose 1x1 transparent box ONLY during upload,
        // and always restore the exact original inline style attribute in finally.
        if (probe.cssPath) {
          const origState = await this.evaluate(
            `((sel) => {
              const el = document.querySelector(sel);
              if (!el) return null;
              const hadStyle = el.hasAttribute('style');
              const origStyle = hadStyle ? el.getAttribute('style') : null;
              el.setAttribute('style', 'opacity:0;width:1px;height:1px;display:block;position:fixed;left:0;top:0;pointer-events:none');
              return { hadStyle, origStyle };
            })(${JSON.stringify(probe.cssPath)})`,
          );

          if (origState) {
            try {
              await this._withResync(() => this._run(
                [
                  'upload',
                  ...fileArgs,
                  '--mode', 'input',
                  '--selector', probe.cssPath,
                  '--session', this.sessionId,
                  '--tab-id', this.targetId,
                  '--json',
                ],
                { bskTimeoutSec: 120 },
              ));
              return { selector: probe.selector };
            } finally {
              try {
                await this.evaluate(
                  `((sel, hadStyle, origStyle) => {
                    const el = document.querySelector(sel);
                    if (!el) return;
                    if (!hadStyle) el.removeAttribute('style');
                    else el.setAttribute('style', origStyle ?? '');
                  })(${JSON.stringify(probe.cssPath)}, ${JSON.stringify(origState.hadStyle)}, ${JSON.stringify(origState.origStyle)})`,
                );
              } catch {
                // Best-effort style restore; never mask upload error.
              }
            }
          }
        }
      }

      await this._humanSleep(jitterDelay(300, 0.25, this.rng));
    }

    throw new Error(`未找到可上传的文件输入框（${timeoutMs}ms）：${list.join(' | ')}`);
  }

  async fillText(selectors, text, { clear = true, timeoutMs = 20_000, humanJitter = true } = {}) {
    const list = normalizeSelectors(selectors);
    if (!list.length) throw new Error('fillText 需要至少一个选择器');

    const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 20_000);
    let info = null;
    while (Date.now() < deadline) {
      info = await this._resolveElementTarget(list, { preferVisible: true });
      if (info && info.visible && info.width > 0 && info.height > 0) break;
      await this._humanSleep(jitterDelay(250, 0.25, this.rng));
    }
    if (!info || !info.visible || !(info.width > 0) || !(info.height > 0)) {
      throw new Error(`输入文本失败，未找到元素（${timeoutMs}ms）：${list.join(' | ')}`);
    }

    const inView = (await this.scrollElementIntoView([info.selector], info)) || info;
    const rawNormalized = String(text ?? '').replace(/\r\n?/g, '\n');
    const content = inView.tagName === 'input'
      ? rawNormalized.replace(/\n/g, ' ')
      : rawNormalized;

    if (!inView.cssPath) {
      throw new Error(`无法为目标输入框生成主文档 CSS 选择器：${inView.selector}`);
    }

    await this._hoverCssPath(inView.cssPath, randInt(90, 200, this.rng));
    await this._withResync(() => this._run(
      [
        'focus',
        '--selector', inView.cssPath,
        '--session', this.sessionId,
        '--tab-id', this.targetId,
        '--json',
      ],
      { bskTimeoutSec: 15 },
    ));
    await this._humanSleep(randInt(60, 140, this.rng));

    if (!content) {
      if (clear) {
        await this._withResync(() => this._run(
          [
            'fill',
            '--selector', inView.cssPath,
            ...formatValueFlag(''),
            '--session', this.sessionId,
            '--tab-id', this.targetId,
            '--json',
          ],
          { bskTimeoutSec: 30 },
        ));
      }
      await this._humanSleep(randInt(100, 220, this.rng));
      return { selector: inView.selector };
    }

    const chunks = humanJitter
      ? splitHumanChunks(content, this.rng)
      : [{ text: content, pauseAfter: false }];

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const useNoClear = i > 0 || !clear;
      const args = [
        'fill',
        ...(useNoClear ? ['--no-clear'] : []),
        '--selector', inView.cssPath,
        ...formatValueFlag(chunk.text),
        '--session', this.sessionId,
        '--tab-id', this.targetId,
        '--json',
      ];
      await this._withResync(() => this._run(args, { bskTimeoutSec: 30 }));

      if (i < chunks.length - 1) {
        const delayMs = chunk.pauseAfter
          ? randInt(260, 550, this.rng)
          : randInt(110, 290, this.rng);
        await this._humanSleep(delayMs);
      }
    }

    await this._humanSleep(randInt(100, 220, this.rng));
    return { selector: inView.selector };
  }

  async typeTag(selectors, tag, { suggestionSelectors = [], commitKey = 'Enter', timeoutMs = 15_000 } = {}) {
    const rawTag = String(tag || '').trim();
    if (!rawTag) return;

    const list = normalizeSelectors(selectors);
    let target = null;
    if (list.length > 0) {
      const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 15_000);
      while (Date.now() < deadline) {
        target = await this._resolveElementTarget(list, { preferVisible: true });
        if (target && target.visible && target.width > 0 && target.height > 0) break;
        await this._humanSleep(jitterDelay(250, 0.25, this.rng));
      }
      if (!target || !target.visible || !(target.width > 0) || !(target.height > 0)) {
        throw new Error(`输入话题标签失败，未找到输入框（${timeoutMs}ms）：${list.join(' | ')}`);
      }
      target = (await this.scrollElementIntoView([target.selector], target)) || target;
      if (!target.cssPath) {
        throw new Error(`无法为话题标签输入框生成主文档 CSS 选择器：${target.selector}`);
      }

      const isContentEditable = Boolean(target.isContentEditable);
      const textToInsert = isContentEditable
        ? (rawTag.startsWith('#') ? ` ${rawTag}` : ` #${rawTag}`)
        : rawTag;

      await this._humanSleep(randInt(90, 180, this.rng));
      // CRITICAL bsk 0.5.0 gotcha: NEVER use `press --selector` on contenteditable (resets caret to offset 0).
      // `fill --no-clear --selector` appends cleanly at the end of contenteditable, textarea, and input.
      await this._withResync(() => this._run(
        [
          'fill',
          '--no-clear',
          '--selector', target.cssPath,
          ...formatValueFlag(textToInsert),
          '--session', this.sessionId,
          '--tab-id', this.targetId,
          '--json',
        ],
        { bskTimeoutSec: 30 },
      ));
      await this._humanSleep(randInt(600, 1300, this.rng));
    }

    const suggestions = normalizeSelectors(suggestionSelectors);
    if (suggestions.length > 0) {
      try {
        await this.waitForAny(suggestions, { timeoutMs: 2_500, visible: true, pollMs: 220 });
        await this.clickAny(suggestions, { timeoutMs: 2_000 });
        await this._humanSleep(randInt(220, 440, this.rng));
        return;
      } catch {
        // Fallback to space append or untargeted commitKey when autocomplete popup does not appear.
      }
    }

    if (commitKey) {
      const normalizedCommit = normalizePressKeyName(commitKey);
      if (target && target.cssPath && normalizedCommit === 'Space') {
        await this._withResync(() => this._run(
          [
            'fill',
            '--no-clear',
            '--selector', target.cssPath,
            '--value', ' ',
            '--session', this.sessionId,
            '--tab-id', this.targetId,
            '--json',
          ],
          { bskTimeoutSec: 20 },
        ));
      } else {
        // Untargeted pressKey (NO --selector) preserves caret position at end of editor.
        await this.pressKey(commitKey);
      }
      await this._humanSleep(randInt(220, 440, this.rng));
    }
  }

  async pressKey(key, modifiers = 0, { holdMs, selector } = {}) {
    const keyName = normalizePressKeyName(key);
    if (!keyName) return;

    const modStr = modifiersToString(modifiers);
    const rawHold = Number.isFinite(holdMs) ? Math.max(0, Math.round(holdMs)) : randInt(40, 105, this.rng);
    const effectiveHold = this.fastMode ? Math.min(rawHold, 10) : rawHold;

    await this._withResync(async () => {
      const args = [
        'press',
        keyName,
        '--session', this.sessionId,
        '--tab-id', this.targetId,
      ];
      if (selector) {
        args.push('--selector', String(selector));
      } else {
        const { contextId, observationId } = await this._ensureFreshObservation();
        if (contextId) args.push('--context', contextId);
        if (observationId) args.push('--observation', observationId);
      }
      if (modStr) {
        args.push('--modifiers', modStr);
      }
      if (effectiveHold > 0) {
        args.push('--hold-ms', String(effectiveHold));
      }
      args.push('--json');
      return this._run(args, { bskTimeoutSec: 20 });
    });
  }

  async screenshot(filePath) {
    const resolved = path.resolve(String(filePath || '').trim());
    fs.mkdirSync(path.dirname(resolved), { recursive: true });

    const res = await this._withResync(async () => {
      const ctx = await this._ensureContext();
      return this._run(
        [
          'screenshot',
          '--session', this.sessionId,
          '--tab-id', this.targetId,
          ...(ctx ? ['--context', ctx] : []),
          '--out', resolved,
          '--json',
        ],
        { bskTimeoutSec: 45 },
      );
    });

    return (res && typeof res.path === 'string' && res.path.trim()) ? res.path : resolved;
  }

  async setCookies() {
    // No-op: bsk drives the user's real Chrome profile with native cookies and device-bound keys.
  }

  async close() {
    if (this.closed) return;
    this.closed = true;

    const session = this.session;
    const sessionClosed = Boolean(session?.closed);

    // Unnavigated about:blank tab: NEVER call `bsk sync` (fails with "Page frames cannot be observed: 0 (about:)").
    // While the session is active, park it as the reusable idle anchor tab for the next `newPage()`.
    if (!this.hasNavigated && !sessionClosed) {
      session?.ownedTabIds?.delete(this.targetId);
      session?.pages?.delete(this.targetId);
      if (session && session.idleTabId === null) {
        session.idleTabId = this.tabId;
      }
      return;
    }

    try {
      // CRITICAL bsk 0.5.0 protocol rule: closing the sole remaining tab closes the Agent Window
      // and terminates the bsk session (`session_window_closed`). Spawn an `about:blank` anchor tab
      // first when no other tab exists in this active session so subsequent `newPage()` calls succeed.
      if (session && !sessionClosed) {
        const hasOtherOwned = [...session.ownedTabIds].some((id) => id !== this.targetId);
        const hasOtherKept = [...session.keptTabIds].some((id) => id !== this.targetId);
        const hasIdle = session.idleTabId !== null && String(session.idleTabId) !== this.targetId;
        if (!hasOtherOwned && !hasOtherKept && !hasIdle) {
          try {
            const anchor = await this._run(
              ['tab', 'create', '--session', this.sessionId, '--url', 'about:blank', '--json'],
              { bskTimeoutSec: 15 },
            );
            if (anchor && anchor.tab_id !== undefined && anchor.tab_id !== null) {
              session.idleTabId = anchor.tab_id;
            }
          } catch {
            // Best-effort anchor creation; proceed with tab close below.
          }
        }
      }

      await this._sync();
      const args = [
        'tab', 'close', this.targetId,
        '--session', this.sessionId,
        ...(this.contextId ? ['--context', this.contextId] : []),
        ...(this.observationId ? ['--observation', this.observationId] : []),
        '--json',
      ];
      this.observationUsed = true;
      await this._run(args, { bskTimeoutSec: 15 });
    } catch {
      // Best-effort: ignore if tab or session is already closed.
    } finally {
      session?.ownedTabIds?.delete(this.targetId);
      session?.pages?.delete(this.targetId);
    }
  }
}

export class BskSession {
  constructor({
    bskBin,
    sessionId,
    browserInstanceId,
    browserLabel = '',
    browser = null,
    agentWindowId = null,
    scope = 'social-video-publisher',
    env = process.env,
    execFileImpl = execFile,
    fastMode = false,
    rng = Math.random,
  }) {
    this.source = 'bsk';
    this.backend = 'bsk';
    this.bskBin = bskBin;
    this.sessionId = String(sessionId);
    this.browserInstanceId = String(browserInstanceId || '');
    this.browserLabel = String(browserLabel || '');
    this.browser = browser;
    this.profileDir = this.browserLabel || null;
    this.agentWindowId = agentWindowId ?? null;
    this.scope = String(scope || 'social-video-publisher');
    this.env = env;
    this.execFileImpl = execFileImpl;
    this.fastMode = Boolean(fastMode);
    this.rng = typeof rng === 'function' ? rng : Math.random;
    this.ownedTabIds = new Set();
    this.keptTabIds = new Set();
    this.pages = new Map();
    this.initialTabUsed = false;
    this.idleTabId = null;
    this.closed = false;
  }

  static async connect({
    browserId = '',
    scope = 'social-video-publisher',
    focus = false,
    width = 1440,
    height = 900,
    env = process.env,
    execFileImpl = execFile,
    fastMode = false,
    rng = Math.random,
    bskBin = '',
    probe = null,
  } = {}) {
    const resolvedProbe = probe && probe.available
      ? probe
      : await probeBskAvailable({ browserId, env, execFileImpl, bskBin });

    if (!resolvedProbe || !resolvedProbe.available) {
      const reason = resolvedProbe?.reason || 'bsk_unavailable';
      const detail = resolvedProbe?.message ? `（${resolvedProbe.message}）` : '';
      throw new BskError({
        exitCode: 2,
        reason,
        message: `无法连接 bsk 真实浏览器：${reason}${detail}`,
      });
    }

    const startArgs = [
      'session', 'start',
      '--browser', resolvedProbe.browser.instance_id,
      '--scope', String(scope || 'social-video-publisher'),
      '--width', String(Math.max(100, Math.round(Number(width) || 1440))),
      '--height', String(Math.max(100, Math.round(Number(height) || 900))),
      focus ? '--focus' : '--no-focus',
      '--agent-name', 'social-video-publisher',
      '--json',
    ];

    const started = await runBsk(startArgs, {
      bskBin: resolvedProbe.bskBin,
      bskTimeoutSec: 20,
      env,
      execFileImpl,
    });

    if (!started || !started.session_id) {
      throw new BskError({
        exitCode: 1,
        reason: 'session_start_invalid',
        message: 'bsk session start 未返回有效的 session_id',
        raw: started,
      });
    }

    return new BskSession({
      bskBin: resolvedProbe.bskBin,
      sessionId: started.session_id,
      browserInstanceId: started.browser_instance_id || resolvedProbe.browser.instance_id,
      browserLabel: resolvedProbe.browser.label || '',
      browser: resolvedProbe.browser,
      agentWindowId: started.agent_window_id ?? null,
      scope,
      env,
      execFileImpl,
      fastMode,
      rng,
    });
  }

  async newPage(initialUrl = 'about:blank') {
    let tabId = null;

    if (this.idleTabId !== null && this.idleTabId !== undefined) {
      tabId = this.idleTabId;
      this.idleTabId = null;
    } else if (!this.initialTabUsed) {
      this.initialTabUsed = true;
      try {
        const listed = await runBsk(
          ['tab', 'list', '--session', this.sessionId, '--scope', 'agent', '--json'],
          {
            bskBin: this.bskBin,
            bskTimeoutSec: 15,
            env: this.env,
            execFileImpl: this.execFileImpl,
          },
        );
        const tabs = Array.isArray(listed?.tabs) ? listed.tabs : [];
        const blankTab = tabs.find((t) => {
          if (!t || t.tab_id === undefined || t.tab_id === null) return false;
          if (this.ownedTabIds.has(String(t.tab_id))) return false;
          const u = String(t.url || '').trim();
          return !u || u === 'about:blank' || u === 'chrome://newtab/';
        });
        if (blankTab) {
          tabId = blankTab.tab_id;
        }
      } catch {
        // Fall through to creating a fresh tab.
      }
    }

    if (tabId === null || tabId === undefined) {
      const created = await runBsk(
        ['tab', 'create', '--session', this.sessionId, '--url', 'about:blank', '--json'],
        {
          bskBin: this.bskBin,
          bskTimeoutSec: 15,
          env: this.env,
          execFileImpl: this.execFileImpl,
        },
      );
      if (!created || created.tab_id === undefined || created.tab_id === null) {
        throw new BskError({
          exitCode: 1,
          reason: 'tab_create_invalid',
          message: 'bsk tab create 未返回有效的 tab_id',
          raw: created,
        });
      }
      tabId = created.tab_id;
    }

    const tabKey = String(tabId);
    this.ownedTabIds.add(tabKey);
    const page = new BskPage(this, {
      tabId,
      fastMode: this.fastMode,
      rng: this.rng,
    });
    this.pages.set(tabKey, page);

    // CRITICAL bsk 0.5.0 rule: `bsk sync` rejects `about:blank` ("Page frames cannot be observed: 0 (about:)").
    // Leave contextId/observationId null for `about:blank` so the first `page.navigate(httpUrl)` runs bare
    // and calls `_sync()` AFTER a real http(s) document loads.
    const targetUrl = String(initialUrl || 'about:blank').trim();
    if (targetUrl && targetUrl !== 'about:blank') {
      await page.navigate(targetUrl);
    }

    return page;
  }

  keepTargetOpen(pageOrId) {
    const rawId = (pageOrId && typeof pageOrId === 'object')
      ? (pageOrId.tabId ?? pageOrId.targetId)
      : pageOrId;
    if (rawId !== undefined && rawId !== null && String(rawId) !== '') {
      this.keptTabIds.add(String(rawId));
    }
  }

  async close({ closeOwnedTabs = true } = {}) {
    if (this.closed) return;
    this.closed = true;

    // When no tabs need to be kept open, skip per-tab `sync`/`tab close` (especially any
    // unnavigated `about:blank` anchor tab) and directly stop the session in one shot.
    if (closeOwnedTabs && this.keptTabIds.size === 0) {
      this.ownedTabIds.clear();
      this.pages.clear();
      this.idleTabId = null;
      try {
        await runBsk(['session', 'stop', this.sessionId, '--json'], {
          bskBin: this.bskBin,
          bskTimeoutSec: 15,
          env: this.env,
          execFileImpl: this.execFileImpl,
        });
      } catch {
        // Best-effort stop; never throw during teardown.
      }
      return;
    }

    if (closeOwnedTabs && this.keptTabIds.size > 0) {
      for (const tabKey of [...this.ownedTabIds]) {
        if (this.keptTabIds.has(tabKey)) continue;
        const page = this.pages.get(tabKey);
        if (page) {
          try {
            await page.close();
          } catch {
            // Best-effort close; never throw.
          }
        } else {
          try {
            const synced = await runBsk(
              ['sync', '--session', this.sessionId, '--tab-id', tabKey, '--json'],
              {
                bskBin: this.bskBin,
                bskTimeoutSec: 15,
                env: this.env,
                execFileImpl: this.execFileImpl,
              },
            );
            const ctx = synced?.context_id || synced?.ctx || '';
            const obs = synced?.observation_id || synced?.obs || '';
            await runBsk(
              [
                'tab', 'close', tabKey,
                '--session', this.sessionId,
                ...(ctx ? ['--context', String(ctx)] : []),
                ...(obs ? ['--observation', String(obs)] : []),
                '--json',
              ],
              {
                bskBin: this.bskBin,
                bskTimeoutSec: 15,
                env: this.env,
                execFileImpl: this.execFileImpl,
              },
            );
          } catch {
            // Best-effort close; never throw.
          }
        }
        this.ownedTabIds.delete(tabKey);
        this.pages.delete(tabKey);
      }
    }

    // CRITICAL: `bsk session stop` closes the entire Agent Window.
    // Because `!closeOwnedTabs || this.keptTabIds.size > 0` here, skip `bsk session stop`
    // so the Agent Window + kept tab(s) stay open for user inspection/login/verification.
  }
}
