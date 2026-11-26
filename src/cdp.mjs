import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  PLATFORM_COOKIE_DOMAINS,
  enrichedPath,
  redactSensitiveText,
  resolveProfileDir,
} from './constants.mjs';

const HTTP_PROBE_TIMEOUT_MS = 2_500;
const CDP_CMD_TIMEOUT_MS = 30_000;
const CHROME_LAUNCH_TIMEOUT_MS = 15_000;

const KEY_DEFS = Object.freeze({
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  ' ': { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function normalizeSelectors(selectors) {
  if (Array.isArray(selectors)) return selectors.map((s) => String(s || '').trim()).filter(Boolean);
  const one = String(selectors || '').trim();
  return one ? [one] : [];
}

/**
 * Parses a local cookie file (0600 header file, Netscape cookies.txt, or JSON array)
 * into CDP Network.setCookies objects. Never logs cookie values.
 */
export function parseCookieFile(filePath, platformOrDomain = '') {
  const resolved = path.resolve(String(filePath || '').trim());
  if (!resolved || !fs.existsSync(resolved)) {
    throw new Error(`Cookie 文件不存在：${resolved}`);
  }
  const raw = fs.readFileSync(resolved, 'utf8').trim();
  if (!raw) return [];

  const platformMeta = PLATFORM_COOKIE_DOMAINS[platformOrDomain];
  const defaultDomain = platformMeta
    ? platformMeta.defaultDomain
    : (String(platformOrDomain || '').trim() || '');

  // 1. JSON array format
  if (raw.startsWith('[') || raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.cookies) ? parsed.cookies : []);
      return list
        .filter((c) => c && c.name && c.value !== undefined)
        .map((c) => ({
          name: String(c.name),
          value: String(c.value),
          domain: String(c.domain || defaultDomain),
          path: String(c.path || '/'),
          secure: Boolean(c.secure ?? true),
          httpOnly: Boolean(c.httpOnly ?? false),
          ...(typeof c.expires === 'number' && c.expires > 0 ? { expires: c.expires } : {}),
        }))
        .filter((c) => c.domain);
    } catch {
      // Fall through to Netscape / header parsing.
    }
  }

  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

  // 2. Netscape tab-separated cookies.txt
  if (lines.some((l) => l.split('\t').length >= 7)) {
    const cookies = [];
    for (const line of lines) {
      const parts = line.split('\t');
      if (parts.length < 7) continue;
      const [domain, , cookiePath, secureStr, expiresStr, name, value] = parts;
      if (!name || !domain) continue;
      const expires = Number(expiresStr);
      cookies.push({
        name: name.trim(),
        value: value ?? '',
        domain: domain.trim(),
        path: (cookiePath || '/').trim(),
        secure: String(secureStr).toUpperCase() === 'TRUE',
        httpOnly: false,
        ...(Number.isFinite(expires) && expires > 0 ? { expires } : {}),
      });
    }
    return cookies;
  }

  // 3. Single-line Cookie header (`k1=v1; k2=v2`)
  if (!defaultDomain) {
    throw new Error('解析单行 Cookie 文件需要指定目标平台或默认域名');
  }
  const headerLine = lines.join('; ').replace(/^cookie\s*:\s*/i, '');
  const cookies = [];
  for (const part of headerLine.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    cookies.push({
      name,
      value,
      domain: defaultDomain,
      path: '/',
      secure: true,
      httpOnly: false,
    });
  }
  return cookies;
}

function tapcanvasActivePortFiles(home = os.homedir(), platform = process.platform, env = process.env) {
  if (platform === 'darwin') {
    const base = path.join(home, 'Library', 'Application Support');
    return [
      path.join(base, 'TapCanvas Pro', 'agent-browser', 'DevToolsActivePort'),
      path.join(base, 'TapCanvas Pro', 'real-browser', 'DevToolsActivePort'),
      path.join(base, 'TapCanvas', 'agent-browser', 'DevToolsActivePort'),
      path.join(base, 'TapCanvas', 'real-browser', 'DevToolsActivePort'),
    ];
  }
  if (platform === 'win32' && env.APPDATA) {
    return [
      path.join(env.APPDATA, 'TapCanvas Pro', 'agent-browser', 'DevToolsActivePort'),
      path.join(env.APPDATA, 'TapCanvas Pro', 'real-browser', 'DevToolsActivePort'),
      path.join(env.APPDATA, 'TapCanvas', 'agent-browser', 'DevToolsActivePort'),
      path.join(env.APPDATA, 'TapCanvas', 'real-browser', 'DevToolsActivePort'),
    ];
  }
  const cfg = path.join(home, '.config');
  return [
    path.join(cfg, 'TapCanvas Pro', 'agent-browser', 'DevToolsActivePort'),
    path.join(cfg, 'TapCanvas Pro', 'real-browser', 'DevToolsActivePort'),
    path.join(cfg, 'TapCanvas', 'agent-browser', 'DevToolsActivePort'),
    path.join(cfg, 'TapCanvas', 'real-browser', 'DevToolsActivePort'),
  ];
}

function readActivePortUrl(activePortFile) {
  try {
    const content = fs.readFileSync(activePortFile, 'utf8').trim();
    if (!content) return null;
    const [portLine] = content.split(/\r?\n/);
    const port = String(portLine || '').trim();
    if (/^\d+$/.test(port)) return `http://127.0.0.1:${port}`;
  } catch {
    // Missing or unreadable file.
  }
  return null;
}

export function discoverCdpCandidates({ cdpUrl = '', profileDir = '', env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const candidates = [];
  const push = (url, source) => {
    const clean = String(url || '').trim().replace(/\/+$/, '');
    if (!clean || candidates.some((c) => c.cdpUrl === clean)) return;
    candidates.push({ cdpUrl: clean, source });
  };

  push(cdpUrl, 'explicit_cdp');
  push(env.TAPCANVAS_BROWSER_CDP, 'tapcanvas_env_cdp');

  const dedicatedProfile = profileDir || resolveProfileDir(env);
  const dedicatedUrl = readActivePortUrl(path.join(dedicatedProfile, 'DevToolsActivePort'));
  if (dedicatedUrl) push(dedicatedUrl, 'dedicated_profile');

  for (const file of tapcanvasActivePortFiles(home, platform, env)) {
    const url = readActivePortUrl(file);
    if (url) push(url, 'tapcanvas_active_port');
  }

  return candidates;
}

export async function probeCdpEndpoint(cdpUrl, timeoutMs = HTTP_PROBE_TIMEOUT_MS) {
  const clean = String(cdpUrl || '').trim().replace(/\/+$/, '');
  if (!clean) return null;
  if (clean.startsWith('ws://') || clean.startsWith('wss://')) {
    return { cdpUrl: clean, wsUrl: clean, browser: 'custom-ws' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${clean}/json/version`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.webSocketDebuggerUrl) return null;
    return {
      cdpUrl: clean,
      wsUrl: data.webSocketDebuggerUrl,
      browser: data.Browser || 'Chromium',
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function findBrowserBinary(platform = process.platform, env = process.env) {
  const explicit = String(env.SOCIAL_PUB_CHROME_PATH || env.CHROME_PATH || '').trim();
  if (explicit && fs.existsSync(explicit)) return explicit;

  if (platform === 'darwin') {
    const macCandidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      path.join(os.homedir(), 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'),
    ];
    return macCandidates.find((p) => fs.existsSync(p)) || null;
  }

  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean);
    const rels = [
      path.join('Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join('Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join('Chromium', 'Application', 'chrome.exe'),
      path.join('BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    ];
    for (const root of roots) {
      for (const rel of rels) {
        const full = path.join(root, rel);
        if (fs.existsSync(full)) return full;
      }
    }
    return null;
  }

  // Linux / BSD
  const bins = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser'];
  const dirs = enrichedPath(env, platform).split(':').filter(Boolean);
  for (const bin of bins) {
    for (const dir of dirs) {
      const full = path.join(dir, bin);
      if (fs.existsSync(full)) return full;
    }
  }
  return null;
}

export async function launchBrowserWithCdp({ profileDir, env = process.env, platform = process.platform } = {}) {
  const binary = findBrowserBinary(platform, env);
  if (!binary) {
    throw new Error('未找到本机 Google Chrome / Edge / Chromium，请安装 Chrome 或通过 TAPCANVAS_BROWSER_CDP 指定调试地址');
  }

  const resolvedProfile = path.resolve(profileDir || resolveProfileDir(env));
  fs.mkdirSync(resolvedProfile, { recursive: true, mode: 0o700 });

  const activePortFile = path.join(resolvedProfile, 'DevToolsActivePort');
  // Remove stale active-port file before launching a fresh instance.
  try {
    const existingUrl = readActivePortUrl(activePortFile);
    if (existingUrl) {
      const alive = await probeCdpEndpoint(existingUrl);
      if (alive) return { ...alive, launched: false, source: 'dedicated_profile', profileDir: resolvedProfile };
      fs.rmSync(activePortFile, { force: true });
    }
  } catch {
    // ignore
  }

  const args = [
    `--user-data-dir=${resolvedProfile}`,
    '--remote-debugging-port=0',
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-infobars',
    '--window-size=1366,900',
    'about:blank',
  ];

  const child = spawn(binary, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...env, PATH: enrichedPath(env, platform) },
  });
  child.unref();

  const deadline = Date.now() + CHROME_LAUNCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const url = readActivePortUrl(activePortFile);
    if (url) {
      const alive = await probeCdpEndpoint(url);
      if (alive) {
        return {
          ...alive,
          launched: true,
          pid: child.pid,
          source: 'launched_chrome',
          profileDir: resolvedProfile,
        };
      }
    }
    await sleep(250);
  }

  throw new Error(`启动浏览器超时（${CHROME_LAUNCH_TIMEOUT_MS}ms），未生成 DevToolsActivePort：${resolvedProfile}`);
}

export class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const entry = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) {
          entry.reject(new Error(redactSensitiveText(msg.error.message || JSON.stringify(msg.error))));
        } else {
          entry.resolve(msg.result || {});
        }
        return;
      }
      if (msg.method) {
        const key = `${msg.sessionId || ''}:${msg.method}`;
        const exact = this.listeners.get(key);
        if (exact) {
          for (const cb of [...exact]) {
            try { cb(msg.params || {}, msg.sessionId); } catch { /* ignore listener errors */ }
          }
        }
        const any = this.listeners.get(`*:${msg.method}`);
        if (any) {
          for (const cb of [...any]) {
            try { cb(msg.params || {}, msg.sessionId); } catch { /* ignore listener errors */ }
          }
        }
      }
    });

    ws.addEventListener('close', () => {
      this.closed = true;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('CDP WebSocket connection closed'));
      }
      this.pending.clear();
    });
  }

  static connect(wsUrl, timeoutMs = 10_000) {
    if (typeof globalThis.WebSocket !== 'function') {
      return Promise.reject(new Error('当前 Node.js 缺少内置 WebSocket（需要 Node 22+）'));
    }
    return new Promise((resolve, reject) => {
      const ws = new globalThis.WebSocket(wsUrl);
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error(`CDP WebSocket 连接超时（${timeoutMs}ms）`));
      }, timeoutMs);

      ws.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(new CdpClient(ws));
      });
      ws.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket 连接失败：${wsUrl}`));
      });
    });
  }

  send(method, params = {}, { sessionId = null, timeoutMs = CDP_CMD_TIMEOUT_MS } = {}) {
    if (this.closed) return Promise.reject(new Error(`CDP 已关闭，无法发送 ${method}`));
    const id = this.nextId++;
    const payload = sessionId ? { id, method, params, sessionId } : { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  on(method, cb, sessionId = '*') {
    const key = `${sessionId}:${method}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(cb);
    return () => {
      const set = this.listeners.get(key);
      if (set) {
        set.delete(cb);
        if (set.size === 0) this.listeners.delete(key);
      }
    };
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/**
 * In-page multi-strategy element finder injected via Runtime.evaluate.
 * Supports:
 * - Standard CSS selectors
 * - `text=...` substring/exact text matching
 * - `<tag>:has-text("...")` Playwright-style pseudo-selector
 * - `xpath=...` or `//...` XPath
 * - Transparent lookup across same-origin iframes (accumulating iframe viewport offsets)
 */
export const IN_PAGE_FINDER_SOURCE = `
function __svFindElement(selectors, preferVisible) {
  function getDocs() {
    const list = [{ doc: document, offsetX: 0, offsetY: 0 }];
    const queue = [{ doc: document, offsetX: 0, offsetY: 0 }];
    while (queue.length > 0) {
      const cur = queue.shift();
      let frames = [];
      try { frames = Array.from(cur.doc.querySelectorAll('iframe')); } catch (_) {}
      for (const frame of frames) {
        try {
          const fdoc = frame.contentDocument;
          if (!fdoc) continue;
          const rect = frame.getBoundingClientRect();
          const entry = { doc: fdoc, offsetX: cur.offsetX + rect.left, offsetY: cur.offsetY + rect.top };
          list.push(entry);
          queue.push(entry);
        } catch (_) {}
      }
    }
    return list;
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    const style = el.ownerDocument.defaultView.getComputedStyle(el);
    if (!style || style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity || '1') === 0) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isDisabled(el) {
    if (!el) return false;
    if (el.disabled === true) return true;
    const aria = el.getAttribute && el.getAttribute('aria-disabled');
    if (aria === 'true') return true;
    return false;
  }

  function matchSelectorInDoc(doc, sel) {
    const trimmed = String(sel || '').trim();
    if (!trimmed) return [];

    // text=...
    if (trimmed.startsWith('text=')) {
      const needle = trimmed.slice(5).trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (!needle) return [];
      const nodes = Array.from(doc.querySelectorAll('button, a, span, div, label, li, p, h1, h2, h3, [role="button"], [role="tab"], [role="menuitem"]'));
      return nodes.filter((el) => {
        const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
        return txt === needle || (txt.includes(needle) && txt.length <= needle.length + 32);
      });
    }

    // xpath=... or //...
    if (trimmed.startsWith('xpath=') || trimmed.startsWith('//')) {
      const expr = trimmed.startsWith('xpath=') ? trimmed.slice(6) : trimmed;
      try {
        const snap = doc.evaluate(expr, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const out = [];
        for (let i = 0; i < snap.snapshotLength; i++) {
          const item = snap.snapshotItem(i);
          if (item && item.nodeType === 1) out.push(item);
        }
        return out;
      } catch (_) {
        return [];
      }
    }

    // <base>:has-text("...")
    const hasTextMatch = trimmed.match(/^(.*?):has-text\\((["'])(.*?)\\2\\)$/);
    if (hasTextMatch) {
      const base = (hasTextMatch[1] || '*').trim() || '*';
      const needle = (hasTextMatch[3] || '').trim().toLowerCase();
      try {
        const nodes = Array.from(doc.querySelectorAll(base));
        return nodes.filter((el) => {
          const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
          return txt.includes(needle);
        });
      } catch (_) {
        return [];
      }
    }

    // Standard CSS
    try {
      return Array.from(doc.querySelectorAll(trimmed));
    } catch (_) {
      return [];
    }
  }

  const docs = getDocs();
  let fallback = null;
  for (const sel of selectors) {
    for (const ctx of docs) {
      const matches = matchSelectorInDoc(ctx.doc, sel);
      for (const el of matches) {
        const vis = isVisible(el);
        const entry = { el, selector: sel, visible: vis, disabled: isDisabled(el), offsetX: ctx.offsetX, offsetY: ctx.offsetY };
        if (!preferVisible) {
          return entry;
        }
        if (vis) return entry;
        if (!fallback) fallback = entry;
      }
    }
  }
  return fallback;
}
`;

export class CdpPage {
  constructor(client, { sessionId, targetId }) {
    this.client = client;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.initialized = false;
  }

  async ensureInitialized() {
    if (this.initialized) return;
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('DOM.enable');
    await this.send('Network.enable');
    // Subtle anti-automation property cleanup on new documents.
    try {
      await this.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `Object.defineProperty(navigator, 'webdriver', { get: () => undefined });`,
      });
    } catch {
      // Non-fatal if restricted.
    }
    this.initialized = true;
  }

  send(method, params = {}, opts = {}) {
    return this.client.send(method, params, { sessionId: this.sessionId, ...opts });
  }

  async sleep(ms) {
    return sleep(ms);
  }

  async navigate(url, { timeoutMs = 45_000 } = {}) {
    await this.ensureInitialized();
    const targetUrl = String(url || '').trim();
    if (!targetUrl) throw new Error('navigate 需要有效的 URL');

    let resolveLoad;
    const loadPromise = new Promise((resolve) => { resolveLoad = resolve; });
    const offLoad = this.client.on('Page.loadEventFired', () => resolveLoad('load'), this.sessionId);
    const offDom = this.client.on('Page.domContentEventFired', () => {
      // Keep waiting briefly for full load, resolved via timeout fallback below.
    }, this.sessionId);

    try {
      const nav = await this.send('Page.navigate', { url: targetUrl }, { timeoutMs });
      if (nav && nav.errorText) {
        throw new Error(`页面导航失败（${targetUrl}）：${nav.errorText}`);
      }
      await Promise.race([
        loadPromise,
        sleep(Math.min(timeoutMs, 15_000)),
      ]);
      // Brief settle for SPA hydration
      await sleep(randomInt(400, 750));
      return { url: await this.url() };
    } finally {
      offLoad();
      offDom();
    }
  }

  async url() {
    await this.ensureInitialized();
    return this.evaluate(() => window.location.href);
  }

  async title() {
    await this.ensureInitialized();
    return this.evaluate(() => document.title);
  }

  async evaluate(fnOrExpr, ...args) {
    await this.ensureInitialized();
    const expression = typeof fnOrExpr === 'function'
      ? `(${fnOrExpr.toString()})(...${JSON.stringify(args)})`
      : String(fnOrExpr);
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      const detail = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Runtime.evaluate exception';
      throw new Error(redactSensitiveText(detail));
    }
    return res.result ? res.result.value : undefined;
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
      await sleep(pollMs);
    }
    throw new Error(`等待页面元素超时（${timeoutMs}ms）：${list.join(' | ')}`);
  }

  async setFiles(selectors, filePaths, { timeoutMs = 15_000 } = {}) {
    await this.ensureInitialized();
    const list = normalizeSelectors(selectors);
    const files = (Array.isArray(filePaths) ? filePaths : [filePaths])
      .map((p) => path.resolve(String(p || '').trim()))
      .filter(Boolean);
    if (!files.length) throw new Error('setFiles 需要至少一个本地文件路径');
    for (const file of files) {
      if (!fs.existsSync(file)) throw new Error(`上传文件不存在：${file}`);
    }

    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 15_000);
    let lastMatchedSelector = null;

    while (Date.now() < deadline) {
      // Ensure DOM tree is tracked before requestNode.
      await this.send('DOM.getDocument', { depth: -1, pierce: true });

      const evalRes = await this.send('Runtime.evaluate', {
        expression: `(() => {
          ${IN_PAGE_FINDER_SOURCE}
          const hit = __svFindElement(${JSON.stringify(list)}, false);
          if (!hit) return null;
          window.__svLastFileSelector = hit.selector;
          return hit.el;
        })()`,
        returnByValue: false,
      });

      const objectId = evalRes?.result?.objectId;
      if (objectId) {
        try {
          lastMatchedSelector = await this.evaluate(() => window.__svLastFileSelector || null);
          const { nodeId } = await this.send('DOM.requestNode', { objectId });
          if (nodeId) {
            await this.send('DOM.setFileInputFiles', { nodeId, files });
            return { selector: lastMatchedSelector || list[0] };
          }
        } finally {
          try { await this.send('Runtime.releaseObject', { objectId }); } catch { /* ignore */ }
        }
      }
      await sleep(300);
    }

    throw new Error(`未找到可上传的文件输入框（${timeoutMs}ms）：${list.join(' | ')}`);
  }

  async _resolveClickPoint(selectors, { preferVisible = true } = {}) {
    const list = normalizeSelectors(selectors);
    const expr = `(() => {
      ${IN_PAGE_FINDER_SOURCE}
      const hit = __svFindElement(${JSON.stringify(list)}, ${Boolean(preferVisible)});
      if (!hit) return null;
      const el = hit.el;
      try { el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }); } catch (_) {}
      const rect = el.getBoundingClientRect();
      return {
        selector: hit.selector,
        visible: hit.visible,
        disabled: hit.disabled,
        x: hit.offsetX + rect.left + rect.width / 2,
        y: hit.offsetY + rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height,
        tagName: (el.tagName || '').toLowerCase(),
        isContentEditable: Boolean(el.isContentEditable),
      };
    })()`;
    return this.evaluate(expr);
  }

  async clickAny(selectors, { timeoutMs = 15_000, humanJitter = true } = {}) {
    await this.ensureInitialized();
    const list = normalizeSelectors(selectors);
    const deadline = Date.now() + Math.max(500, Number(timeoutMs) || 15_000);
    let point = null;
    while (Date.now() < deadline) {
      point = await this._resolveClickPoint(list, { preferVisible: true });
      if (point && point.visible && point.width > 0 && point.height > 0) break;
      await sleep(250);
    }
    if (!point) {
      throw new Error(`点击失败，未找到元素（${timeoutMs}ms）：${list.join(' | ')}`);
    }

    const jitterX = humanJitter ? randomInt(-2, 2) : 0;
    const jitterY = humanJitter ? randomInt(-2, 2) : 0;
    const x = Math.max(1, Math.round(point.x + jitterX));
    const y = Math.max(1, Math.round(point.y + jitterY));

    if (humanJitter) await sleep(randomInt(70, 180));
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await sleep(randomInt(25, 65));
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });

    return { selector: point.selector };
  }

  async pressKey(key, modifiers = 0) {
    await this.ensureInitialized();
    const rawKey = String(key || '');
    const def = KEY_DEFS[rawKey] || {
      key: rawKey,
      code: rawKey.length === 1 ? `Key${rawKey.toUpperCase()}` : rawKey,
      windowsVirtualKeyCode: rawKey.length === 1 ? rawKey.toUpperCase().charCodeAt(0) : 0,
      text: rawKey.length === 1 ? rawKey : undefined,
    };

    await this.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode,
      nativeVirtualKeyCode: def.windowsVirtualKeyCode,
      modifiers,
      ...(def.text ? { text: def.text, unmodifiedText: def.text } : {}),
    });
    if (def.text && !modifiers) {
      await this.send('Input.dispatchKeyEvent', {
        type: 'char',
        key: def.key,
        code: def.code,
        text: def.text,
        unmodifiedText: def.text,
        windowsVirtualKeyCode: def.windowsVirtualKeyCode,
      });
    }
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.windowsVirtualKeyCode,
      nativeVirtualKeyCode: def.windowsVirtualKeyCode,
      modifiers,
    });
  }

  async fillText(selectors, text, { clear = true, humanJitter = true, timeoutMs = 15_000 } = {}) {
    await this.ensureInitialized();
    const list = normalizeSelectors(selectors);
    const content = String(text ?? '');
    const clicked = await this.clickAny(list, { timeoutMs, humanJitter });

    // Ensure DOM focus on the exact matched element.
    await this.evaluate(
      `(() => {
        ${IN_PAGE_FINDER_SOURCE}
        const hit = __svFindElement(${JSON.stringify([clicked.selector])}, true);
        if (hit && hit.el && typeof hit.el.focus === 'function') hit.el.focus();
      })()`,
    );

    if (clear) {
      // Select all via Cmd+A (macOS) or Ctrl+A (Linux/Win), then Backspace.
      const selectAllMod = process.platform === 'darwin' ? 4 : 2; // Meta=4, Control=2
      await this.pressKey('a', selectAllMod);
      await sleep(40);
      await this.pressKey('Backspace');
      await sleep(40);

      // Backup clear for controlled <input>/<textarea> if still populated.
      await this.evaluate(
        `(() => {
          ${IN_PAGE_FINDER_SOURCE}
          const hit = __svFindElement(${JSON.stringify([clicked.selector])}, true);
          if (!hit || !hit.el) return;
          const el = hit.el;
          const tag = (el.tagName || '').toLowerCase();
          if ((tag === 'input' || tag === 'textarea') && el.value) {
            const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, '');
            else el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        })()`,
      );
    }

    if (humanJitter) await sleep(randomInt(60, 150));
    if (content) {
      await this.send('Input.insertText', { text: content });
    }
    if (humanJitter) await sleep(randomInt(80, 180));

    // Verify input/textarea accepted value; fallback to native setter + events if needed.
    await this.evaluate(
      `((expected) => {
        ${IN_PAGE_FINDER_SOURCE}
        const hit = __svFindElement(${JSON.stringify([clicked.selector])}, true);
        if (!hit || !hit.el) return;
        const el = hit.el;
        const tag = (el.tagName || '').toLowerCase();
        if ((tag === 'input' || tag === 'textarea') && expected && !String(el.value || '').includes(expected.slice(0, Math.min(12, expected.length)))) {
          const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (setter) setter.call(el, expected);
          else el.value = expected;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })(${JSON.stringify(content)})`,
    );

    return { selector: clicked.selector };
  }

  async typeTag(selectors, tag, { suggestionSelectors = [], commitKey = 'Enter', timeoutMs = 15_000 } = {}) {
    await this.ensureInitialized();
    const rawTag = String(tag || '').trim();
    if (!rawTag) return;

    const list = normalizeSelectors(selectors);
    let isContentEditable = false;
    if (list.length > 0) {
      const clicked = await this.clickAny(list, { timeoutMs, humanJitter: true });
      isContentEditable = Boolean(await this.evaluate(
        `(() => {
          ${IN_PAGE_FINDER_SOURCE}
          const hit = __svFindElement(${JSON.stringify([clicked.selector])}, true);
          if (!hit || !hit.el) return false;
          const el = hit.el;
          if (el.isContentEditable) {
            el.focus();
            const range = el.ownerDocument.createRange();
            range.selectNodeContents(el);
            range.collapse(false);
            const sel = el.ownerDocument.defaultView.getSelection();
            if (sel) {
              sel.removeAllRanges();
              sel.addRange(range);
            }
            return true;
          }
          return false;
        })()`,
      ));
    }

    const textToInsert = isContentEditable
      ? (rawTag.startsWith('#') ? ` ${rawTag}` : ` #${rawTag}`)
      : rawTag;

    await sleep(randomInt(80, 160));
    await this.send('Input.insertText', { text: textToInsert });
    await sleep(randomInt(500, 900));

    const suggestions = normalizeSelectors(suggestionSelectors);
    if (suggestions.length > 0) {
      try {
        await this.waitForAny(suggestions, { timeoutMs: 2_500, visible: true, pollMs: 200 });
        await this.clickAny(suggestions, { timeoutMs: 2_000, humanJitter: true });
        await sleep(randomInt(200, 400));
        return;
      } catch {
        // Fallback to commitKey when autocomplete popup does not appear.
      }
    }

    if (commitKey) {
      await this.pressKey(commitKey);
      await sleep(randomInt(200, 400));
    }
  }

  async screenshot(filePath) {
    await this.ensureInitialized();
    const resolved = path.resolve(String(filePath || '').trim());
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const ext = path.extname(resolved).toLowerCase();
    const format = ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : 'png';
    const res = await this.send('Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality: 85 } : {}) });
    if (!res || !res.data) throw new Error('Page.captureScreenshot 未返回图像数据');
    fs.writeFileSync(resolved, Buffer.from(res.data, 'base64'));
    return resolved;
  }

  async setCookies(cookies) {
    await this.ensureInitialized();
    const list = Array.isArray(cookies) ? cookies : [];
    if (!list.length) return;
    const normalized = list
      .filter((c) => c && c.name && c.value !== undefined && (c.domain || c.url))
      .map((c) => ({
        name: String(c.name),
        value: String(c.value),
        ...(c.domain ? { domain: String(c.domain) } : {}),
        ...(c.url ? { url: String(c.url) } : {}),
        path: String(c.path || '/'),
        secure: Boolean(c.secure ?? true),
        httpOnly: Boolean(c.httpOnly ?? false),
        ...(typeof c.expires === 'number' && c.expires > 0 ? { expires: c.expires } : {}),
      }));
    if (!normalized.length) return;
    await this.send('Network.setCookies', { cookies: normalized });
  }

  async close() {
    if (!this.targetId) return;
    try {
      await this.client.send('Target.closeTarget', { targetId: this.targetId });
    } catch {
      // Ignore if tab already closed.
    }
  }
}

export class BrowserSession {
  constructor(client, meta = {}) {
    this.client = client;
    this.cdpUrl = meta.cdpUrl || '';
    this.wsUrl = meta.wsUrl || '';
    this.source = meta.source || 'unknown';
    this.launched = Boolean(meta.launched);
    this.profileDir = meta.profileDir || '';
    this.ownedTargetIds = new Set();
  }

  static async connect({ cdpUrl = '', profileDir = '', env = process.env, launchIfMissing = true } = {}) {
    const candidates = discoverCdpCandidates({ cdpUrl, profileDir, env });
    let connected = null;
    for (const candidate of candidates) {
      const alive = await probeCdpEndpoint(candidate.cdpUrl);
      if (alive) {
        connected = { ...alive, source: candidate.source, launched: false, profileDir: profileDir || resolveProfileDir(env) };
        break;
      }
    }

    if (!connected) {
      if (!launchIfMissing) {
        throw new Error('未检测到运行中的 Chrome CDP 端口，且已禁用自动启动');
      }
      connected = await launchBrowserWithCdp({ profileDir, env });
    }

    const client = await CdpClient.connect(connected.wsUrl);
    return new BrowserSession(client, connected);
  }

  async newPage(initialUrl = 'about:blank') {
    const { targetId } = await this.client.send('Target.createTarget', { url: initialUrl });
    this.ownedTargetIds.add(targetId);
    const { sessionId } = await this.client.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const page = new CdpPage(this.client, { sessionId, targetId });
    await page.ensureInitialized();
    return page;
  }

  keepTargetOpen(page) {
    if (page && page.targetId) {
      this.ownedTargetIds.delete(page.targetId);
    }
  }

  async close({ closeOwnedTabs = true } = {}) {
    if (closeOwnedTabs) {
      for (const targetId of [...this.ownedTargetIds]) {
        try {
          await this.client.send('Target.closeTarget', { targetId });
        } catch {
          // Ignore already closed targets.
        }
      }
    }
    this.ownedTargetIds.clear();
    this.client.close();
  }
}
