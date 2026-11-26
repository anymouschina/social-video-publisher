// Enable fast-mode timings strictly inside the automated test suite.
process.env.SOCIAL_PUB_FAST_HUMAN = '1';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  DEVICE_BOUND_COOKIE_PLATFORMS,
  PLUGIN_NAME,
  PLUGIN_VERSION,
  clampWaitSeconds,
  redactSensitiveText,
} from '../src/constants.mjs';
import {
  buildBezierPath,
  buildTypingPlan,
  buildWheelChunks,
  isFastHumanMode,
  jitterDelay,
  randInt,
  sampleInteriorPoint,
} from '../src/human.mjs';
import {
  CdpPage,
  IN_PAGE_FINDER_SOURCE,
  WEBDRIVER_STEALTH_SCRIPT,
  buildLaunchArgs,
  discoverCdpCandidates,
  parseCookieFile,
} from '../src/cdp.mjs';
import { shouldKeepTabOpen } from '../src/job-runner.mjs';
import { probeMediaFile } from '../src/media-probe.mjs';
import { LocalStorage } from '../src/storage.mjs';
import { TOOLS, createPublisherService } from '../src/server.mjs';
import {
  ADAPTERS,
  getAdapter,
  listPlatformSpecs,
  resolvePlatformId,
} from '../src/adapters/index.mjs';
import {
  checkPageGuardState,
  readGuardPageText,
} from '../src/adapters/base.mjs';
import { computeXWeightedLength } from '../src/adapters/x.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

function findTapCanvasAgentPlugins() {
  const candidates = [
    path.resolve(PLUGIN_ROOT, '..', 'TapCanvas-pro', 'apps', 'desktop', 'src', 'agent-runtime', 'agent-plugins.cjs'),
    path.resolve(PLUGIN_ROOT, '..', '..', 'apps', 'desktop', 'src', 'agent-runtime', 'agent-plugins.cjs'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/**
 * Stateful mock CdpPage covering all 4 adapters cleanly without needing a real browser.
 */
function createMockPage(config = {}) {
  const state = {
    currentUrl: config.initialUrl || 'about:blank',
    pageText: config.initialText || '',
    uploaded: false,
    clickedPublish: false,
    clickedDraft: false,
    visibleSelectors: new Set(config.visibleSelectors || []),
    disabledSelectors: new Set(config.disabledSelectors || []),
    accountName: config.accountName || null,
    publishedStatusUrl: config.publishedStatusUrl || null,
    cookies: [],
    calls: [],
  };

  function matchesAny(selectors, set) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const sel of list) {
      if (set.has(sel)) return sel;
    }
    return null;
  }

  return {
    state,
    async navigate(url) {
      state.calls.push({ method: 'navigate', url });
      state.currentUrl = config.redirectUrlOnNavigate || url;
      if (typeof config.onNavigate === 'function') {
        config.onNavigate(state, url);
      }
      return { url: state.currentUrl };
    },
    async url() {
      return state.currentUrl;
    },
    async title() {
      return config.title || 'Mock Creator Center';
    },
    async evaluate(fnOrExpr, ...args) {
      const src = typeof fnOrExpr === 'function' ? fnOrExpr.toString() : String(fnOrExpr);
      // 1. readPageText
      if (src.includes('document.body.innerText')) {
        return state.pageText;
      }
      // 2. extractAccountName / extractAccountHandle
      if (src.includes('SideNav_AccountSwitcher_Button') || src.includes('.account-name') || src.includes('.header-right-name')) {
        return state.accountName;
      }
      // 3. extractPublishedStatusUrl on X
      if (src.includes('a[href*="/status/"]')) {
        return state.clickedPublish ? state.publishedStatusUrl : null;
      }
      // 4. resolveUploadFrameUrl on Bilibili
      if (src.includes('iframe[name="videoUpload"]')) {
        return config.iframeSrc || null;
      }
      // 5. Read-only clickWithTextFallback text matcher (zero data-svp-click DOM mutation!)
      if (src.includes('INTERACTIVE_SELECTOR') && src.includes('FALLBACK_SELECTOR')) {
        const labels = Array.isArray(args[0]) ? args[0] : [];
        const matched = labels.find((l) => (config.clickableTextLabels || []).includes(l));
        if (matched) {
          state.calls.push({ method: 'findTextRect', label: matched });
          if (typeof config.onClickText === 'function') {
            config.onClickText(state, matched);
          }
          return {
            found: true,
            text: matched,
            rect: { x: 420, y: 360, left: 420, top: 360, width: 120, height: 40 },
          };
        }
        return null;
      }
      return null;
    },
    async queryAny(selectors) {
      const hit = matchesAny(selectors, state.visibleSelectors);
      if (!hit) {
        return { selector: null, found: false, visible: false, text: '', disabled: false };
      }
      return {
        selector: hit,
        found: true,
        visible: true,
        text: '',
        disabled: state.disabledSelectors.has(hit),
      };
    },
    async waitForAny(selectors) {
      const hit = matchesAny(selectors, state.visibleSelectors);
      if (!hit) throw new Error(`Mock waitForAny miss: ${selectors.join(', ')}`);
      return { selector: hit, found: true, visible: true, text: '', disabled: state.disabledSelectors.has(hit) };
    },
    async setFiles(selectors, filePaths) {
      state.calls.push({ method: 'setFiles', selectors, filePaths });
      state.uploaded = true;
      if (typeof config.onSetFiles === 'function') {
        config.onSetFiles(state, selectors, filePaths);
      }
      const list = Array.isArray(selectors) ? selectors : [selectors];
      return { selector: list[0] };
    },
    async clickAny(selectors) {
      const list = Array.isArray(selectors) ? selectors : [selectors];
      const hit = matchesAny(list, state.visibleSelectors);
      if (!hit) {
        throw new Error(`Mock clickAny miss: ${list.join(', ')}`);
      }
      state.calls.push({ method: 'clickAny', selector: hit });
      if (typeof config.onClick === 'function') {
        config.onClick(state, hit);
      }
      return { selector: hit };
    },
    async clickPoint(rect) {
      state.calls.push({ method: 'clickPoint', rect });
      return { x: Math.round((rect?.left ?? rect?.x ?? 0) + (rect?.width ?? 10) / 2), y: Math.round((rect?.top ?? rect?.y ?? 0) + (rect?.height ?? 10) / 2) };
    },
    async hoverAny(selectors, opts) {
      const list = Array.isArray(selectors) ? selectors : [selectors];
      const hit = matchesAny(list, state.visibleSelectors);
      state.calls.push({ method: 'hoverAny', selectors: list, found: Boolean(hit), opts });
      return hit ? { found: true, selector: hit, x: 480, y: 320 } : { found: false, selector: null };
    },
    async idleDrift(opts) {
      state.calls.push({ method: 'idleDrift', opts });
      return { x: 450, y: 280, steps: opts?.steps ?? 1 };
    },
    async fillText(selectors, text, opts) {
      const list = Array.isArray(selectors) ? selectors : [selectors];
      state.calls.push({ method: 'fillText', selector: list[0], text, opts });
      return { selector: list[0] };
    },
    async typeTag(selectors, tag, opts) {
      state.calls.push({ method: 'typeTag', tag, opts });
    },
    async pressKey(key) {
      state.calls.push({ method: 'pressKey', key });
    },
    async screenshot(filePath) {
      state.calls.push({ method: 'screenshot', filePath });
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, Buffer.from('PNG_MOCK'));
      return filePath;
    },
    async setCookies(cookies) {
      state.cookies.push(...cookies);
      state.calls.push({ method: 'setCookies', count: cookies.length });
    },
    async sleep() {
      // Instant in mock tests.
    },
    async close() {
      state.calls.push({ method: 'close' });
    },
  };
}

function createTempMedia(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svp-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const videoPath = path.join(tmpDir, 'demo.mp4');
  const coverPath = path.join(tmpDir, 'cover.jpg');
  fs.writeFileSync(videoPath, Buffer.from('fake-mp4-video-content-0123456789'));
  fs.writeFileSync(coverPath, Buffer.from('fake-jpg-cover-content'));
  return { tmpDir, videoPath, coverPath };
}

test('manifests, skill and .mcp.json pass TapCanvas inspectPlugin, probeMcp and AgentPlugins install/forTurn', async (t) => {
  // Check standalone invariants first (always runs even outside TapCanvas-pro workspace)
  const claudeManifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const codexManifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json'), 'utf8'));
  const mcpConfig = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.mcp.json'), 'utf8'));

  assert.equal(claudeManifest.name, PLUGIN_NAME);
  assert.equal(codexManifest.name, PLUGIN_NAME);
  assert.equal(claudeManifest.version, PLUGIN_VERSION);
  assert.equal(codexManifest.version, PLUGIN_VERSION);
  assert.equal(claudeManifest.description, codexManifest.description);
  assert.equal(
    codexManifest.interface.logo,
    'https://tanvas-ai.tos-cn-guangzhou.volces.com/gen/plugin-logos/20261126/social-video-publisher-d32c9cdf.jpg',
  );
  assert.ok(mcpConfig.mcpServers.social_pub);
  assert.equal(mcpConfig.mcpServers.social_pub.env, undefined, '.mcp.json must not hardcode TAPCANVAS_BROWSER_CDP in env');

  for (const tool of TOOLS) {
    const fullName = `mcp__social_pub__${tool.name}`;
    assert.ok(fullName.length <= 64, `Tool name too long (${fullName.length}): ${fullName}`);
  }

  const agentPluginsPath = findTapCanvasAgentPlugins();
  if (!agentPluginsPath) return;

  const { AgentPlugins, inspectPlugin, probeMcp } = require(agentPluginsPath);

  const info = inspectPlugin(PLUGIN_ROOT, { requireFormats: ['claude', 'codex'] });
  assert.deepEqual(info.problems, []);
  assert.equal(info.name, 'social-video-publisher');
  assert.equal(info.version, '0.2.0');
  assert.equal(info.logoUrl, codexManifest.interface.logo);
  assert.equal(info.skills.length, 1);
  assert.equal(info.skills[0].name, 'social-video-publish');
  assert.ok(info.mcpServers.social_pub);

  const probe = await probeMcp(info.mcpServers.social_pub, { timeoutMs: 10_000 });
  assert.equal(probe.ok, true, probe.error || probe.stderr);
  assert.deepEqual(
    probe.tools.sort(),
    [
      'cancel_publish_job',
      'check_accounts',
      'get_publish_job',
      'list_platforms',
      'list_publish_history',
      'open_login',
      'prepare_publish_plan',
      'start_publish_job',
    ],
  );

  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'svp-agent-plugins-'));
  const tmpCodex = fs.mkdtempSync(path.join(os.tmpdir(), 'svp-codex-home-'));
  t.after(() => [tmpData, tmpCodex].forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  const manager = new AgentPlugins({ dataDir: tmpData });
  const installed = await manager.install(PLUGIN_ROOT);
  assert.equal(installed.enabled, true);
  assert.deepEqual(installed.problems, []);
  assert.deepEqual(installed.mcpServers, ['social_pub']);

  // Also verify probeMcp against the installed copy under tmpData (which sits behind
  // macOS /var -> /private/var symlink, catching any non-realpath isMain bugs!)
  const installedInspect = inspectPlugin(manager.installedDir(installed.name), { requireFormats: ['claude', 'codex'] });
  const installedProbe = await probeMcp(installedInspect.mcpServers.social_pub, { timeoutMs: 10_000 });
  assert.equal(installedProbe.ok, true, installedProbe.error || installedProbe.stderr);
  assert.equal(installedProbe.tools.length, 8);

  const claudeTurn = manager.forTurn('claude');
  assert.equal(claudeTurn.plugins.length, 1);
  assert.deepEqual(claudeTurn.names, ['social-video-publisher@0.2.0']);

  const codexTurn = manager.forTurn('codex');
  assert.ok(codexTurn.mcpServers.social_pub);
  assert.deepEqual(manager.installForCodex(tmpCodex), ['social-video-publish']);
});

test('stdio JSON-RPC server handles initialize, tools/list, list_platforms, prepare_publish_plan, fail-closed publish guard and history', async (t) => {
  const { tmpDir, videoPath } = createTempMedia(t);
  const dataDir = path.join(tmpDir, 'data');

  const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'src', 'server.mjs')], {
    cwd: PLUGIN_ROOT,
    env: { ...process.env, SOCIAL_PUB_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { try { child.kill(); } catch { /* ignore */ } });

  const repliesById = new Map();
  let buffer = '';
  const listeners = new Set();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined) repliesById.set(msg.id, msg);
      for (const fn of [...listeners]) fn();
    }
  });

  const waitForId = (id) => new Promise((resolve, reject) => {
    if (repliesById.has(id)) return resolve(repliesById.get(id));
    const timer = setTimeout(() => {
      listeners.delete(check);
      reject(new Error(`MCP timed out waiting for reply id=${id}`));
    }, 8000);
    const check = () => {
      if (repliesById.has(id)) {
        clearTimeout(timer);
        listeners.delete(check);
        resolve(repliesById.get(id));
      }
    };
    listeners.add(check);
    child.on('error', reject);
  });

  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_platforms', arguments: {} } });
  send({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'prepare_publish_plan',
      arguments: {
        videoPath,
        title: 'AI 视频工作流实战分享',
        description: '从分镜到成片的一站式创作记录',
        tags: ['AI视频', 'AIGC', '创作工具'],
        platforms: ['xhs', 'dy', 'twitter', 'b站'],
      },
    },
  });

  const [r1, r2, r3, r4] = await Promise.all([waitForId(1), waitForId(2), waitForId(3), waitForId(4)]);

  assert.equal(r1.result.serverInfo.name, 'social-video-publisher');
  assert.equal(r1.result.protocolVersion, '2025-06-18');
  assert.equal(r2.result.tools.length, 8);

  const listed = JSON.parse(r3.result.content[0].text);
  assert.equal(listed.ok, true);
  assert.equal(listed.platforms.length, 4);
  assert.equal(listed.safetyDefaults.defaultMode, 'draft');
  assert.equal(listed.safetyDefaults.publishRequiresConfirmedTrue, true);

  const planRes = JSON.parse(r4.result.content[0].text);
  assert.equal(planRes.ok, true);
  assert.ok(planRes.planId.startsWith('plan_'));
  assert.equal(planRes.items.length, 4);
  assert.deepEqual(planRes.items.map((i) => i.platform), ['xiaohongshu', 'douyin', 'x', 'bilibili']);
  assert.equal(planRes.video.sha256.length, 64);

  // Fail-closed test: mode="publish" WITHOUT confirmed: true MUST be rejected deterministically!
  send({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'start_publish_job',
      arguments: { planId: planRes.planId, mode: 'publish' },
    },
  });
  send({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'list_publish_history', arguments: { limit: 10 } },
  });

  const [r5, r6] = await Promise.all([waitForId(5), waitForId(6)]);

  assert.equal(r5.result.isError, true);
  const blocked = JSON.parse(r5.result.content[0].text);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 'confirmation_required');

  const history = JSON.parse(r6.result.content[0].text);
  assert.equal(history.ok, true);
  assert.equal(history.count, 0);
});

test('core utilities: media probe fallback without ffprobe, cookie parser, CDP priority & redaction', async (t) => {
  const { tmpDir, videoPath } = createTempMedia(t);

  // Missing ffprobe degrades gracefully to stat-only
  const probe = await probeMediaFile(videoPath, { kind: 'video', env: { PATH: '' } });
  assert.equal(probe.ok, true);
  assert.equal(probe.probedBy, 'stat');
  assert.equal(probe.sha256.length, 64);

  const missing = await probeMediaFile(path.join(tmpDir, 'nope.mp4'));
  assert.equal(missing.ok, false);

  // Redaction
  const redacted = redactSensitiveText('Cookie: web_session=supersecret123; sessionid=abc999 auth_token=tok_xyz');
  assert.doesNotMatch(redacted, /supersecret123|abc999|tok_xyz/);
  assert.match(redacted, /\[REDACTED_COOKIE\]/);

  // waitSeconds clamp
  assert.equal(clampWaitSeconds(-5), 0);
  assert.equal(clampWaitSeconds(120), 45);
  assert.equal(clampWaitSeconds(undefined), 25);

  // parseCookieFile: header, Netscape, JSON
  const headerFile = path.join(tmpDir, 'xhs.cookie');
  fs.writeFileSync(headerFile, 'web_session=sec1; a1=sec2\n', { mode: 0o600 });
  const headerCookies = parseCookieFile(headerFile, 'xiaohongshu');
  assert.equal(headerCookies.length, 2);
  assert.equal(headerCookies[0].domain, '.xiaohongshu.com');

  const netscapeFile = path.join(tmpDir, 'netscape.txt');
  fs.writeFileSync(netscapeFile, '# Netscape\n.douyin.com\tTRUE\t/\tTRUE\t1999999999\tsessionid\tdy_tok\n');
  const netscapeCookies = parseCookieFile(netscapeFile);
  assert.equal(netscapeCookies.length, 1);
  assert.equal(netscapeCookies[0].name, 'sessionid');
  assert.equal(netscapeCookies[0].domain, '.douyin.com');

  const jsonFile = path.join(tmpDir, 'x.json');
  fs.writeFileSync(jsonFile, JSON.stringify([{ name: 'auth_token', value: 'xtok', domain: '.x.com' }]));
  const jsonCookies = parseCookieFile(jsonFile);
  assert.equal(jsonCookies.length, 1);
  assert.equal(jsonCookies[0].name, 'auth_token');

  // CDP discovery priority
  const fakeProfile = path.join(tmpDir, 'profile');
  fs.mkdirSync(fakeProfile, { recursive: true });
  fs.writeFileSync(path.join(fakeProfile, 'DevToolsActivePort'), '9333\n/devtools/browser/abc\n');
  const candidates = discoverCdpCandidates({
    cdpUrl: 'http://127.0.0.1:9111',
    env: { TAPCANVAS_BROWSER_CDP: 'http://127.0.0.1:9222' },
    profileDir: fakeProfile,
    home: tmpDir,
  });
  assert.deepEqual(
    candidates.map((c) => c.cdpUrl),
    ['http://127.0.0.1:9111', 'http://127.0.0.1:9222', 'http://127.0.0.1:9333'],
  );

  // __svFindElement: when preferVisible=false (used by setFiles), a hidden specific
  // video input MUST win over a later visible generic file input; when preferVisible=true,
  // visible elements still take precedence over hidden ones.
  const makeFakeEl = ({ id, visible }) => ({
    id,
    nodeType: 1,
    disabled: false,
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => (visible
          ? { display: 'block', visibility: 'visible', opacity: '1' }
          : { display: 'none', visibility: 'hidden', opacity: '0' }),
      },
    },
    getBoundingClientRect: () => (visible ? { width: 120, height: 32, left: 0, top: 0 } : { width: 0, height: 0, left: 0, top: 0 }),
    getAttribute: () => null,
  });
  const hiddenVideoInput = makeFakeEl({ id: 'video-input', visible: false });
  const visibleImageInput = makeFakeEl({ id: 'cover-input', visible: true });
  const fakeDocument = {
    querySelectorAll: (sel) => {
      if (sel === 'iframe') return [];
      if (sel === 'input[type="file"][accept*="video"]') return [hiddenVideoInput];
      if (sel === 'input[type="file"]') return [hiddenVideoInput, visibleImageInput];
      return [];
    },
  };
  const findElement = new Function('document', `${IN_PAGE_FINDER_SOURCE}; return __svFindElement;`)(fakeDocument);

  const fileHit = findElement(['input[type="file"][accept*="video"]', 'input[type="file"]'], false);
  assert.equal(fileHit.selector, 'input[type="file"][accept*="video"]');
  assert.equal(fileHit.el.id, 'video-input');
  assert.equal(fileHit.visible, false);

  const visibleHit = findElement(['input[type="file"][accept*="video"]', 'input[type="file"]'], true);
  assert.equal(visibleHit.el.id, 'cover-input');
  assert.equal(visibleHit.visible, true);
});

test('adapter registry resolves canonical IDs and aliases cleanly', () => {
  assert.equal(listPlatformSpecs().length, 4);
  assert.equal(resolvePlatformId('xhs'), 'xiaohongshu');
  assert.equal(resolvePlatformId('小红书'), 'xiaohongshu');
  assert.equal(resolvePlatformId('dy'), 'douyin');
  assert.equal(resolvePlatformId('twitter'), 'x');
  assert.equal(resolvePlatformId('b站'), 'bilibili');
  assert.equal(resolvePlatformId('unknown-site'), null);
  assert.equal(ADAPTERS.twitter.spec.id, 'x');
  assert.equal(getAdapter('xhs').spec.id, 'xiaohongshu');
});

test('all 4 adapters validate limits, schedule windows, and X weighted character counts', () => {
  const future4h = new Date(Date.now() + 4 * 3600 * 1000).toISOString();
  const tooSoon10m = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  // Xiaohongshu: title clamped to 20, schedule valid >= 60m
  const xhsOk = getAdapter('xiaohongshu').validate({
    videoPath: '/tmp/a.mp4',
    title: '这是一个超级长的小红书测试标题一定会超过二十个字符上限',
    description: '正文',
    tags: ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10', 't11'],
    scheduleAt: future4h,
  });
  assert.equal(xhsOk.valid, true);
  assert.equal(Array.from(xhsOk.adapted.title).length, 20);
  assert.equal(xhsOk.adapted.tags.length, 10);
  assert.ok(xhsOk.warnings.length >= 2);

  const xhsBadSched = getAdapter('xiaohongshu').validate({
    videoPath: '/tmp/a.mp4',
    title: '短标题',
    scheduleAt: tooSoon10m,
  });
  assert.equal(xhsBadSched.valid, false);

  // Douyin: title clamped to 30, maxTags 5
  const dyOk = getAdapter('douyin').validate({
    videoPath: '/tmp/a.mp4',
    title: 'a'.repeat(40),
    tags: ['1', '2', '3', '4', '5', '6'],
    scheduleAt: future4h,
  });
  assert.equal(dyOk.valid, true);
  assert.equal(dyOk.adapted.title.length, 30);
  assert.equal(dyOk.adapted.tags.length, 5);

  // X: weighted length > 280 truncated with warning on standard, allowed on xPremium, schedule rejected
  const longCjk = '中'.repeat(160); // weighted length 320
  assert.equal(computeXWeightedLength(longCjk), 320);
  const xStd = getAdapter('x').validate({ videoPath: '/tmp/a.mp4', description: longCjk });
  assert.equal(xStd.valid, true);
  assert.ok(xStd.adapted.weightedLength <= 280);
  assert.ok(xStd.warnings.some((w) => w.includes('280')));

  const xPrem = getAdapter('x').validate({
    videoPath: '/tmp/a.mp4',
    description: longCjk,
    options: { xPremium: true },
  });
  assert.equal(xPrem.valid, true);
  assert.equal(xPrem.adapted.weightedLength, 320);

  const xSched = getAdapter('x').validate({ videoPath: '/tmp/a.mp4', description: 'hi', scheduleAt: future4h });
  assert.equal(xSched.valid, false);

  // Bilibili: title <= 80, tags <= 10, schedule >= 120m
  const biliOk = getAdapter('bilibili').validate({
    videoPath: '/tmp/a.mp4',
    title: 'B站投稿测试标题',
    tags: ['AIGC'],
    scheduleAt: future4h,
  });
  assert.equal(biliOk.valid, true);
});

test('adapter E2E mock CdpPage tests: xiaohongshu (checkAuth, draft, publish, needs_login, needs_verification)', async (t) => {
  const { tmpDir, videoPath, coverPath } = createTempMedia(t);
  const adapter = getAdapter('xiaohongshu');

  // checkAuth logged_in
  const authPage = createMockPage({
    visibleSelectors: ['input.upload-input'],
    accountName: '小红书创作者A',
  });
  const authRes = await adapter.checkAuth(authPage);
  assert.equal(authRes.loggedIn, true);
  assert.equal(authRes.status, 'logged_in');
  assert.equal(authRes.accountName, '小红书创作者A');

  // needs_login
  const loginPage = createMockPage({
    redirectUrlOnNavigate: 'https://creator.xiaohongshu.com/login',
    visibleSelectors: ['.login-container'],
  });
  const loginRes = await adapter.publishVideo(loginPage, {
    videoPath,
    title: '测试标题',
    mode: 'draft',
    screenshotDir: tmpDir,
  });
  assert.equal(loginRes.status, 'needs_login');
  assert.ok(fs.existsSync(loginRes.screenshotPath));

  // draft mode
  const draftPage = createMockPage({
    visibleSelectors: ['input.upload-input', 'input[placeholder*="填写标题"]', '.ql-editor', '.reupload-btn', 'button.draft-btn', '.cover-edit-btn', '.cover-upload input[type="file"]', '.cover-modal button.d-button--primary'],
    clickableTextLabels: ['上传封面', '确定'],
  });
  const draftRes = await adapter.publishVideo(draftPage, {
    videoPath,
    coverPath,
    title: '赛博朋克短片',
    description: '幕后制作分享',
    tags: ['AI视频', '短片'],
    mode: 'draft',
    screenshotDir: tmpDir,
    options: { pollIntervalMs: 1 },
  });
  assert.equal(draftRes.status, 'draft_saved');
  assert.ok(fs.existsSync(draftRes.screenshotPath));

  // publish mode
  const pubPage = createMockPage({
    visibleSelectors: ['input.upload-input', 'input[placeholder*="填写标题"]', '.ql-editor', '.reupload-btn', 'button.publishBtn'],
    onClick: (st, sel) => {
      if (sel === 'button.publishBtn') {
        st.clickedPublish = true;
        st.currentUrl = 'https://creator.xiaohongshu.com/publish/success';
        st.pageText = '发布成功';
      }
    },
  });
  const pubRes = await adapter.publishVideo(pubPage, {
    videoPath,
    title: '赛博朋克短片',
    description: '正式发布',
    tags: ['AI视频'],
    mode: 'publish',
    screenshotDir: tmpDir,
    options: { pollIntervalMs: 1, publishTimeoutMs: 500 },
  });
  assert.equal(pubRes.status, 'published');
  assert.ok(fs.existsSync(pubRes.screenshotPath));

  // needs_verification
  const verPage = createMockPage({
    visibleSelectors: ['input.upload-input', 'input[placeholder*="填写标题"]', '.ql-editor', '.reupload-btn', 'button.publishBtn'],
    onClick: (st, sel) => {
      if (sel === 'button.publishBtn') {
        st.pageText = '请完成安全验证，输入短信验证码';
      }
    },
  });
  const verRes = await adapter.publishVideo(verPage, {
    videoPath,
    title: '触发风控测试',
    mode: 'publish',
    screenshotDir: tmpDir,
    options: { pollIntervalMs: 1, publishTimeoutMs: 500 },
  });
  assert.equal(verRes.status, 'needs_verification');
  assert.ok(fs.existsSync(verRes.screenshotPath));
});

test('adapter E2E mock CdpPage tests: douyin (checkAuth, draft, publish, needs_login, needs_verification)', async (t) => {
  const { tmpDir, videoPath } = createTempMedia(t);
  const adapter = getAdapter('douyin');

  const authPage = createMockPage({
    visibleSelectors: ['input[type="file"][accept*="video"]'],
    accountName: '抖音测试号',
  });
  const authRes = await adapter.checkAuth(authPage);
  assert.equal(authRes.loggedIn, true);
  assert.equal(authRes.accountName, '抖音测试号');

  // needs_login
  const loginPage = createMockPage({
    redirectUrlOnNavigate: 'https://creator.douyin.com/',
    visibleSelectors: ['.login-guide-btn'],
  });
  const loginRes = await adapter.publishVideo(loginPage, {
    videoPath,
    title: '抖音测试',
    mode: 'draft',
    screenshotDir: tmpDir,
  });
  assert.equal(loginRes.status, 'needs_login');

  // draft
  const draftPage = createMockPage({
    visibleSelectors: ['input[type="file"][accept*="video"]', 'input[placeholder*="填写作品标题"]', '.zone-container', '.preview-video', 'button[class*="draft"]'],
    initialText: '重新上传',
  });
  const draftRes = await adapter.publishVideo(draftPage, {
    videoPath,
    title: '抖音草稿标题',
    description: '抖音简介',
    tags: ['AIGC'],
    mode: 'draft',
    screenshotDir: tmpDir,
    options: { pollIntervalMs: 1 },
  });
  assert.equal(draftRes.status, 'draft_saved');

  // publish -> redirect to /creator-micro/content/manage
  const pubPage = createMockPage({
    visibleSelectors: ['input[type="file"][accept*="video"]', 'input[placeholder*="填写作品标题"]', '.zone-container', '.preview-video', 'button[class*="publish-btn"]'],
    initialText: '重新上传',
    onClick: (st, sel) => {
      if (sel === 'button[class*="publish-btn"]') {
        st.clickedPublish = true;
        st.currentUrl = 'https://creator.douyin.com/creator-micro/content/manage';
      }
    },
  });
  const pubRes = await adapter.publishVideo(pubPage, {
    videoPath,
    title: '抖音正式发布',
    mode: 'publish',
    screenshotDir: tmpDir,
    options: { pollIntervalMs: 1, publishTimeoutMs: 500 },
  });
  assert.equal(pubRes.status, 'published');

  // post-click SMS verification modal
  const smsPage = createMockPage({
    visibleSelectors: ['input[type="file"][accept*="video"]', 'input[placeholder*="填写作品标题"]', '.zone-container', '.preview-video', 'button[class*="publish-btn"]'],
    initialText: '重新上传',
    onClick: (st, sel) => {
      if (sel === 'button[class*="publish-btn"]') {
        st.visibleSelectors.add('.uc-ui-verify');
        st.pageText = '请输入短信验证码完成手机号验证';
      }
    },
  });
  const smsRes = await adapter.publishVideo(smsPage, {
    videoPath,
    title: '首次上传短信验证',
    mode: 'publish',
    screenshotDir: tmpDir,
    options: { pollIntervalMs: 1, publishTimeoutMs: 500 },
  });
  assert.equal(smsRes.status, 'needs_verification');
  assert.ok(fs.existsSync(smsRes.screenshotPath));
});

test('adapter E2E mock CdpPage tests: x (CRITICAL upload-before-text ordering, draft, publish, needs_login, needs_verification)', async (t) => {
  const { tmpDir, videoPath } = createTempMedia(t);
  const adapter = getAdapter('x');

  // checkAuth
  const authPage = createMockPage({
    visibleSelectors: ['[data-testid="tweetTextarea_0"]'],
    accountName: '@tapcanvas_dev',
  });
  const authRes = await adapter.checkAuth(authPage);
  assert.equal(authRes.loggedIn, true);
  assert.equal(authRes.accountName, '@tapcanvas_dev');

  // needs_login
  const loginPage = createMockPage({
    redirectUrlOnNavigate: 'https://x.com/i/flow/login',
    visibleSelectors: ['input[autocomplete="username"]'],
  });
  const loginRes = await adapter.publishVideo(loginPage, {
    videoPath,
    description: 'Hello X',
    mode: 'draft',
    screenshotDir: tmpDir,
  });
  assert.equal(loginRes.status, 'needs_login');

  // draft: MUST upload video FIRST before fillText, and MUST NOT click tweetButton!
  const draftPage = createMockPage({
    visibleSelectors: ['input[data-testid="fileInput"]', '[data-testid="tweetTextarea_0"]', '[data-testid="tweetButton"]'],
    onSetFiles: (st) => {
      st.visibleSelectors.add('[data-testid="attachments"]');
    },
  });
  const draftRes = await adapter.publishVideo(draftPage, {
    videoPath,
    title: 'TapCanvas Demo',
    description: 'Multi-platform video publishing.',
    tags: ['AI', 'Video'],
    mode: 'draft',
    screenshotDir: tmpDir,
    options: { pollIntervalMs: 1 },
  });
  assert.equal(draftRes.status, 'draft_saved');
  const setFilesIdx = draftPage.state.calls.findIndex((c) => c.method === 'setFiles');
  const fillTextIdx = draftPage.state.calls.findIndex((c) => c.method === 'fillText');
  assert.ok(setFilesIdx >= 0 && fillTextIdx > setFilesIdx, 'X adapter MUST upload video BEFORE typing tweet text');
  assert.equal(
    draftPage.state.calls.some((c) => c.method === 'clickAny' && c.selector === '[data-testid="tweetButton"]'),
    false,
    'X draft mode must NOT click tweetButton',
  );

  // publish: captures /status/ permalink
  const pubPage = createMockPage({
    visibleSelectors: ['input[data-testid="fileInput"]', '[data-testid="tweetTextarea_0"]', '[data-testid="tweetButton"]'],
    publishedStatusUrl: 'https://x.com/tapcanvas_dev/status/1899999999999999999',
    onSetFiles: (st) => {
      st.visibleSelectors.add('[data-testid="attachments"]');
    },
    onClick: (st, sel) => {
      if (sel === '[data-testid="tweetButton"]') {
        st.clickedPublish = true;
        st.pageText = 'Your post was sent';
      }
    },
  });
  const pubRes = await adapter.publishVideo(pubPage, {
    videoPath,
    description: 'Launching our video!',
    mode: 'publish',
    screenshotDir: tmpDir,
    options: { pollIntervalMs: 1, publishTimeoutMs: 500 },
  });
  assert.equal(pubRes.status, 'published');
  assert.equal(pubRes.url, 'https://x.com/tapcanvas_dev/status/1899999999999999999');

  // needs_verification (challenge URL)
  const challengePage = createMockPage({
    redirectUrlOnNavigate: 'https://x.com/account/access',
    initialText: 'Please verify you are human',
  });
  const challengeRes = await adapter.publishVideo(challengePage, {
    videoPath,
    description: 'Challenge test',
    mode: 'publish',
    screenshotDir: tmpDir,
  });
  assert.equal(challengeRes.status, 'needs_verification');
});

test('adapter E2E mock CdpPage tests: bilibili (checkAuth, draft, publish, needs_login, needs_verification)', async (t) => {
  const { tmpDir, videoPath } = createTempMedia(t);
  const adapter = getAdapter('bilibili');

  const authPage = createMockPage({
    visibleSelectors: ['.bcc-upload-wrapper input[type="file"]'],
  });
  const authRes = await adapter.checkAuth(authPage);
  assert.equal(authRes.loggedIn, true);

  // needs_login
  const loginPage = createMockPage({
    redirectUrlOnNavigate: 'https://passport.bilibili.com/login',
    visibleSelectors: ['.login-scan-wp'],
  });
  const loginRes = await adapter.publishVideo(loginPage, {
    videoPath,
    title: 'B站测试',
    tags: ['AIGC'],
    mode: 'draft',
    screenshotDir: tmpDir,
  });
  assert.equal(loginRes.status, 'needs_login');

  // draft
  const draftPage = createMockPage({
    visibleSelectors: [
      '.bcc-upload-wrapper input[type="file"]',
      'input[placeholder*="请输入稿件标题"]',
      'input[placeholder*="按回车键Enter创建标签"]',
      '.ql-editor',
      'span.submit-draft',
    ],
    initialText: '上传完成 100%',
  });
  const draftRes = await adapter.publishVideo(draftPage, {
    videoPath,
    title: 'B站草稿测试',
    description: '简介内容',
    tags: ['AI', '视频'],
    mode: 'draft',
    screenshotDir: tmpDir,
    options: { pollIntervalMs: 1 },
  });
  assert.equal(draftRes.status, 'draft_saved');

  // publish
  const pubPage = createMockPage({
    visibleSelectors: [
      '.bcc-upload-wrapper input[type="file"]',
      'input[placeholder*="请输入稿件标题"]',
      'input[placeholder*="按回车键Enter创建标签"]',
      '.ql-editor',
      'span.submit-add',
    ],
    initialText: '上传完成 100%',
    onClick: (st, sel) => {
      if (sel === 'span.submit-add') {
        st.clickedPublish = true;
        st.pageText = '稿件投递成功';
        st.currentUrl = 'https://member.bilibili.com/platform/upload/video/result';
      }
    },
  });
  const pubRes = await adapter.publishVideo(pubPage, {
    videoPath,
    title: 'B站正式投稿',
    description: '正式投稿简介',
    tags: ['AI'],
    mode: 'publish',
    screenshotDir: tmpDir,
    options: { pollIntervalMs: 1, publishTimeoutMs: 500 },
  });
  assert.equal(pubRes.status, 'published');

  // needs_verification (geetest captcha modal)
  const verPage = createMockPage({
    visibleSelectors: [
      '.bcc-upload-wrapper input[type="file"]',
      'input[placeholder*="请输入稿件标题"]',
      'input[placeholder*="按回车键Enter创建标签"]',
      '.ql-editor',
      'span.submit-add',
    ],
    initialText: '上传完成 100%',
    onClick: (st, sel) => {
      if (sel === 'span.submit-add') {
        st.visibleSelectors.add('.geetest_panel');
        st.pageText = '请完成安全验证';
      }
    },
  });
  const verRes = await adapter.publishVideo(verPage, {
    videoPath,
    title: 'B站风控验证测试',
    tags: ['AI'],
    mode: 'publish',
    screenshotDir: tmpDir,
    options: { pollIntervalMs: 1, publishTimeoutMs: 500 },
  });
  assert.equal(verRes.status, 'needs_verification');
});

test('multi-platform sequential PublishJobRunner end-to-end: draft, dedupe detection, cookie isolation, and confirmed publish', async (t) => {
  const { tmpDir, videoPath } = createTempMedia(t);
  const dataDir = path.join(tmpDir, 'data');
  const cookieFile = path.join(tmpDir, 'xhs.cookie');
  fs.writeFileSync(cookieFile, 'web_session=SUPER_SECRET_COOKIE_VAL; a1=ANOTHER_SECRET\n', { mode: 0o600 });

  const openedPages = [];
  const sessionFactory = async () => ({
    source: 'mock_cdp',
    profileDir: path.join(tmpDir, 'profile'),
    keptTargets: [],
    async newPage() {
      const page = createMockPage({
        visibleSelectors: [
          'input.upload-input',
          'input[placeholder*="填写标题"]',
          '.ql-editor',
          '.reupload-btn',
          'button.draft-btn',
          'button.publishBtn',
          'input[type="file"][accept*="video"]',
          'input[placeholder*="填写作品标题"]',
          '.zone-container',
          '.preview-video',
          'button[class*="draft"]',
          'button[class*="publish-btn"]',
          'input[data-testid="fileInput"]',
          '[data-testid="tweetTextarea_0"]',
          '[data-testid="tweetButton"]',
          '.bcc-upload-wrapper input[type="file"]',
          'input[placeholder*="请输入稿件标题"]',
          'input[placeholder*="按回车键Enter创建标签"]',
          'span.submit-draft',
          'span.submit-add',
        ],
        initialText: '重新上传 上传完成 100%',
        publishedStatusUrl: 'https://x.com/demo/status/1234567890',
        onSetFiles: (st) => {
          st.visibleSelectors.add('[data-testid="attachments"]');
        },
        onClick: (st, sel) => {
          if (sel === 'button.publishBtn') {
            st.clickedPublish = true;
            st.pageText = '发布成功';
            st.currentUrl = 'https://creator.xiaohongshu.com/publish/success';
          } else if (sel === 'button[class*="publish-btn"]') {
            st.clickedPublish = true;
            st.currentUrl = 'https://creator.douyin.com/creator-micro/content/manage';
          } else if (sel === '[data-testid="tweetButton"]') {
            st.clickedPublish = true;
            st.pageText = 'Your post was sent';
          } else if (sel === 'span.submit-add') {
            st.clickedPublish = true;
            st.pageText = '稿件投递成功';
          }
        },
      });
      openedPages.push(page);
      return page;
    },
    keepTargetOpen(page) {
      this.keptTargets.push(page);
    },
    async close() {},
  });

  const service = createPublisherService({
    dataDir,
    sessionFactory,
    probeMediaFile: (file, opts) => probeMediaFile(file, { ...opts, skipFfprobe: true }),
  });

  // 1. Prepare plan across all 4 platforms
  const plan = await service.callTool('prepare_publish_plan', {
    videoPath,
    title: '一条视频多平台发布演示',
    description: '自动化工作流展示',
    tags: ['AI', '视频'],
    platforms: ['xiaohongshu', 'douyin', 'x', 'bilibili'],
    options: { pollIntervalMs: 1, publishTimeoutMs: 500 },
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.duplicates.length, 0);

  // 2. Run draft job sequentially with cookieFile
  const draftJobRes = await service.callTool('start_publish_job', {
    planId: plan.planId,
    mode: 'draft',
    cookieFiles: { xiaohongshu: cookieFile },
    waitSeconds: 5,
  });
  assert.equal(draftJobRes.ok, true);
  assert.equal(draftJobRes.done, true);
  assert.equal(draftJobRes.job.status, 'completed');
  assert.equal(draftJobRes.job.results.length, 4);
  assert.ok(draftJobRes.job.results.every((r) => r.status === 'draft_saved'));

  // Device-bound cookieFiles for XHS MUST be blocked by default, and NEVER leaked into storage files
  assert.equal(openedPages[0].state.cookies.length, 0, 'XHS cross-profile cookieFiles must be refused by default');
  assert.equal(draftJobRes.job.results[0].cookieInjectionBlocked, true);
  assert.equal(draftJobRes.job.results[0].diagnostics.cookieInjectionBlocked, true);
  const rawHistory = fs.readFileSync(path.join(dataDir, 'history.jsonl'), 'utf8');
  assert.doesNotMatch(rawHistory, /SUPER_SECRET_COOKIE_VAL|ANOTHER_SECRET/);

  // 3. Re-preparing plan on same video triggers SHA-256 duplicate alert
  const plan2 = await service.callTool('prepare_publish_plan', {
    videoPath,
    title: '同一视频二次发布',
    platforms: ['xhs', 'dy'],
    options: { pollIntervalMs: 1, publishTimeoutMs: 500 },
  });
  assert.equal(plan2.duplicates.length, 2);

  // 4. Unconfirmed publish is rejected deterministically
  const unconfirmed = await service.callTool('start_publish_job', {
    planId: plan.planId,
    mode: 'publish',
    confirmed: false,
  });
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.status, 'confirmation_required');

  // 5. Confirmed publish succeeds across all 4 platforms
  const pubJobRes = await service.callTool('start_publish_job', {
    planId: plan.planId,
    mode: 'publish',
    confirmed: true,
    waitSeconds: 5,
  });
  assert.equal(pubJobRes.ok, true);
  assert.equal(pubJobRes.done, true);
  assert.equal(pubJobRes.job.status, 'completed');
  assert.ok(pubJobRes.job.results.every((r) => r.status === 'published'));

  // 6. History reflects 8 total receipts (4 draft + 4 publish)
  const historyRes = await service.callTool('list_publish_history', { limit: 20 });
  assert.equal(historyRes.count, 8);
  const xOnly = await service.callTool('list_publish_history', { platform: 'twitter', limit: 20 });
  assert.equal(xOnly.count, 2);
});

function createSeededRng(seed = 42) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

test('human.mjs kinematics: interior point bounds, Bezier path, ASCII+CJK typing plan, wheel chunks & jitter', () => {
  assert.equal(isFastHumanMode(), true);
  assert.equal(isFastHumanMode({ fastMode: true }), true);

  const rng = createSeededRng(20261126);

  // 1. sampleInteriorPoint: 200 samples strictly within [22%, 78%] and never exact geometric center
  const rect = { left: 100, top: 200, width: 200, height: 100 };
  const rectAlt = { x: 100, y: 200, width: 200, height: 100 };
  let exactCenterHits = 0;
  for (let i = 0; i < 200; i += 1) {
    const pt = sampleInteriorPoint(i % 2 === 0 ? rect : rectAlt, { rng });
    assert.ok(pt.x >= 100 + 200 * 0.22 && pt.x <= 100 + 200 * 0.78, `x out of [22%, 78%]: ${pt.x}`);
    assert.ok(pt.y >= 200 + 100 * 0.22 && pt.y <= 200 + 100 * 0.78, `y out of [22%, 78%]: ${pt.y}`);
    if (pt.x === 200 && pt.y === 250) exactCenterHits += 1;
  }
  assert.equal(exactCenterHits, 0, 'sampleInteriorPoint must avoid exact geometric center');

  // 2. buildBezierPath: smooth Fitts-scaled curve with 8-22ms cadence, non-collinear arc & exact endpoint
  const pathLong = buildBezierPath({ x: 120, y: 150 }, { x: 860, y: 620 }, { rng: createSeededRng(7), overshootChance: 1 });
  assert.ok(pathLong.length >= 15 && pathLong.length <= 54, `unexpected path length: ${pathLong.length}`);
  assert.deepEqual(
    { x: pathLong[pathLong.length - 1].x, y: pathLong[pathLong.length - 1].y },
    { x: 860, y: 620 },
  );
  let maxPerpDev = 0;
  const lineDx = 860 - 120;
  const lineDy = 620 - 150;
  const lineLen = Math.hypot(lineDx, lineDy);
  for (const pt of pathLong) {
    assert.ok(pt.delayMs >= 8 && pt.delayMs <= 22, `step delayMs out of [8,22]: ${pt.delayMs}`);
    const perp = Math.abs((pt.x - 120) * lineDy - (pt.y - 150) * lineDx) / lineLen;
    if (perp > maxPerpDev) maxPerpDev = perp;
  }
  assert.ok(maxPerpDev > 5, `Bezier curve must deviate from straight line, got ${maxPerpDev}`);

  // Short move (<250px) without overshoot
  const pathShort = buildBezierPath({ x: 300, y: 300 }, { x: 420, y: 340 }, { rng: createSeededRng(9), overshootChance: 0 });
  assert.ok(pathShort.length >= 12 && pathShort.length <= 48);
  assert.equal(pathShort[pathShort.length - 1].x, 420);
  assert.equal(pathShort[pathShort.length - 1].y, 340);

  // 3. buildTypingPlan: mixed ASCII + CJK + punctuation + emoji never dumps a paragraph in one call
  const longText = 'TapCanvas v0.2.0 发布！这是一段用于验证拟人化输入节奏的中文测试文本，包含标点符号、换行\n以及多句自然停顿。最后加上🚀和 #AI视频 标签！';
  const plan = buildTypingPlan(longText, { rng: createSeededRng(11) });
  assert.equal(plan.map((s) => s.text).join(''), longText, 'reconstructed text must match input exactly');
  const keySteps = plan.filter((s) => s.kind === 'key');
  const imeSteps = plan.filter((s) => s.kind === 'ime');
  assert.ok(keySteps.length >= 15, 'ASCII characters must emit per-char key steps');
  assert.ok(imeSteps.length >= 10, 'CJK/emoji text must split into small 1-4 char IME chunks');
  for (const k of keySteps) {
    assert.equal(Array.from(k.text).length, 1);
    assert.ok(k.holdMs >= 35 && k.holdMs <= 95, `key holdMs out of range: ${k.holdMs}`);
    assert.ok((k.delayMs >= 50 && k.delayMs <= 155) || (k.delayMs >= 220 && k.delayMs <= 480));
  }
  for (const ime of imeSteps) {
    const len = Array.from(ime.text).length;
    assert.ok(len >= 1 && len <= 4, `IME chunk too large (${len}): ${ime.text}`);
    assert.ok(ime.preDelayMs >= 120 && ime.preDelayMs <= 290);
    assert.ok((ime.delayMs >= 60 && ime.delayMs <= 160) || (ime.delayMs >= 300 && ime.delayMs <= 680));
  }

  // 3b. buildTypingPlan normalizes CRLF and bare CR to single LF (no '\r' step or double newline)
  const crlfPlan = buildTypingPlan('a\r\nb\rc', { rng: createSeededRng(12) });
  assert.equal(crlfPlan.map((s) => s.text).join(''), 'a\nb\nc');
  assert.equal(crlfPlan.some((s) => s.text === '\r'), false, 'must normalize \\r\\n and \\r to \\n');

  // 4. buildWheelChunks: 3-8 chunks summing exactly to deltaY, 45-120ms cadence
  for (const delta of [680, -940, 180]) {
    const chunks = buildWheelChunks(delta, { rng: createSeededRng(13) });
    assert.ok(chunks.length >= 3 && chunks.length <= 8, `chunk count out of [3,8]: ${chunks.length}`);
    assert.equal(chunks.reduce((sum, c) => sum + c.deltaY, 0), delta);
    for (const c of chunks) {
      assert.equal(Math.sign(c.deltaY), Math.sign(delta));
      assert.ok(c.delayMs >= 45 && c.delayMs <= 120);
    }
  }
  // Tiny deltas 1..4 (positive & negative) MUST NEVER reverse sign!
  for (const tiny of [1, -1, 2, -2, 3, -3, 4, -4]) {
    const chunks = buildWheelChunks(tiny, { rng: createSeededRng(14) });
    assert.ok(chunks.length >= 1);
    assert.equal(chunks.reduce((sum, c) => sum + c.deltaY, 0), tiny);
    for (const c of chunks) {
      assert.equal(Math.sign(c.deltaY), Math.sign(tiny), `sign reversal on tiny delta=${tiny}: ${JSON.stringify(chunks)}`);
    }
  }

  // 5. jitterDelay & randInt
  for (let i = 0; i < 50; i += 1) {
    const j = jitterDelay(1000, 0.25, rng);
    assert.ok(j >= 750 && j <= 1250);
    const r = randInt(5, 10, rng);
    assert.ok(r >= 5 && r <= 10 && Number.isInteger(r));
  }
});

test('CdpPage humanized physics, stealth launch flags, prototype-only webdriver cleanup, and zero window.__svLastFileSelector leak', async (t) => {
  const { videoPath } = createTempMedia(t);

  // 1. Launch flags: keep AutomationControlled, remove --disable-infobars, use 1440,900
  const launchArgs = buildLaunchArgs({ profileDir: '/tmp/fake-profile' });
  assert.ok(launchArgs.includes('--disable-blink-features=AutomationControlled'));
  assert.ok(launchArgs.includes('--window-size=1440,900'));
  assert.equal(launchArgs.includes('--disable-infobars'), false, 'deprecated --disable-infobars must be removed');

  // 2. WEBDRIVER_STEALTH_SCRIPT: only patches Navigator.prototype when webdriver === true (no own property on navigator!)
  {
    const FakeNavProto = {};
    Object.defineProperty(FakeNavProto, 'webdriver', { get: () => true, configurable: true });
    const fakeNav = Object.create(FakeNavProto);
    new Function('navigator', WEBDRIVER_STEALTH_SCRIPT)(fakeNav);
    assert.equal(fakeNav.webdriver, undefined);
    assert.equal(Object.getOwnPropertyDescriptor(fakeNav, 'webdriver'), undefined, 'must NOT create own property on navigator');
  }
  {
    const FakeNavProto = {};
    Object.defineProperty(FakeNavProto, 'webdriver', { get: () => false, configurable: true });
    const fakeNav = Object.create(FakeNavProto);
    new Function('navigator', WEBDRIVER_STEALTH_SCRIPT)(fakeNav);
    assert.equal(fakeNav.webdriver, false, 'must not touch navigator when webdriver is already false');
  }

  // 3. CdpPage CDP command trace: Bezier mouseMoved, clickPoint bringToFront + press/release, setFiles without window leak or DOM.getDocument flood
  const cdpCalls = [];
  let setFilesProbeCount = 0;
  const fakeClient = {
    on: () => () => {},
    async send(method, params = {}) {
      cdpCalls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '');
        // Assert zero window.__svLastFileSelector leak anywhere!
        assert.equal(expr.includes('__svLastFileSelector'), false, 'must never reference window.__svLastFileSelector');
        assert.equal(expr.includes('data-svp-click'), false, 'cdp.mjs must never inject data-svp-click');
        if (expr.includes('window.innerWidth')) {
          return { result: { value: { width: 1440, height: 900, scrollY: 0 } } };
        }
        if (expr.includes('hit ? { found: true, selector: hit.selector }')) {
          setFilesProbeCount += 1;
          // First probe misses (verifies DOM.getDocument is NOT called on miss), second succeeds
          return {
            result: {
              value: setFilesProbeCount >= 2
                ? { found: true, selector: 'input[type="file"]' }
                : { found: false, selector: null },
            },
          };
        }
        if (params.returnByValue === false) {
          return { result: { objectId: 'obj-file-1' } };
        }
        if (expr.includes('getBoundingClientRect')) {
          return {
            result: {
              value: {
                selector: '.upload-zone',
                visible: true,
                disabled: false,
                left: 400,
                top: 300,
                x: 400,
                y: 300,
                width: 240,
                height: 120,
                tagName: 'div',
                isContentEditable: false,
              },
            },
          };
        }
        return { result: { value: false } };
      }
      if (method === 'DOM.requestNode') return { nodeId: 77 };
      return {};
    },
  };

  const page = new CdpPage(fakeClient, {
    sessionId: 'sess-1',
    targetId: 'target-1',
    fastMode: true,
    rng: createSeededRng(101),
  });

  // clickPoint dispatches bringToFront + multi-step Bezier mouseMoved + pressed(buttons=1) + released(buttons=0)
  const clickedPt = await page.clickPoint({ left: 500, top: 320, width: 160, height: 50 });
  assert.ok(clickedPt.x >= 500 + 160 * 0.22 && clickedPt.x <= 500 + 160 * 0.78);
  assert.ok(clickedPt.y >= 320 + 50 * 0.22 && clickedPt.y <= 320 + 50 * 0.78);
  assert.ok(cdpCalls.some((c) => c.method === 'Page.bringToFront'));
  const moves = cdpCalls.filter((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mouseMoved');
  assert.ok(moves.length >= 12, `expected multi-step Bezier moves, got ${moves.length}`);
  assert.ok(moves.every((m) => m.params.pointerType === 'mouse'));
  const pressed = cdpCalls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mousePressed');
  const released = cdpCalls.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params.type === 'mouseReleased');
  assert.equal(pressed.params.buttons, 1);
  assert.equal(released.params.buttons, 0);
  assert.equal(page.cursorX, clickedPt.x);
  assert.equal(page.cursorY, clickedPt.y);

  // hoverAny & idleDrift work smoothly
  const hovered = await page.hoverAny(['.upload-zone']);
  assert.equal(hovered.found, true);
  assert.equal(hovered.selector, '.upload-zone');
  const drift = await page.idleDrift({ steps: 2 });
  assert.equal(drift.steps, 2);

  // setFiles calls DOM.getDocument ONLY ONCE when file input is found (not during miss tick)
  const docCallsBefore = cdpCalls.filter((c) => c.method === 'DOM.getDocument').length;
  const setRes = await page.setFiles(['input[type="file"]'], videoPath);
  assert.equal(setRes.selector, 'input[type="file"]');
  const docCallsAfter = cdpCalls.filter((c) => c.method === 'DOM.getDocument').length;
  assert.equal(docCallsAfter - docCallsBefore, 1, 'DOM.getDocument must only run once when file input is ready');
  assert.ok(cdpCalls.some((c) => c.method === 'DOM.setFileInputFiles' && c.params.nodeId === 77));

  // fillText types ASCII via keyDown/keyUp (no unconditional char) and CJK via small-chunk Input.insertText;
  // on darwin, clear uses commands: ['selectAll']
  const cdpBeforeType = cdpCalls.length;
  await page.fillText(['.upload-zone'], 'Hi世界和平测试！', { clear: true });
  const typeCalls = cdpCalls.slice(cdpBeforeType);
  const rawKeyDowns = typeCalls.filter((c) => c.method === 'Input.dispatchKeyEvent' && c.params.type === 'rawKeyDown');
  const textKeyDowns = typeCalls.filter((c) => c.method === 'Input.dispatchKeyEvent' && c.params.type === 'keyDown');
  const charEvents = typeCalls.filter((c) => c.method === 'Input.dispatchKeyEvent' && c.params.type === 'char');
  const inserts = typeCalls.filter((c) => c.method === 'Input.insertText');
  assert.equal(charEvents.length, 0, 'must not emit unconditional char events that bypass keydown preventDefault()');
  assert.ok(rawKeyDowns.length >= 2, 'must emit selectAll and Backspace rawKeyDown');
  if (process.platform === 'darwin') {
    assert.deepEqual(rawKeyDowns[0].params.commands, ['selectAll'], 'darwin clear must pass commands: ["selectAll"]');
  }
  assert.ok(textKeyDowns.length >= 2, 'ASCII characters must emit per-char keyDown events');
  assert.ok(inserts.length >= 2, 'CJK string must be chunked across multiple small Input.insertText calls');
  assert.equal(inserts.map((i) => i.params.text).join(''), '世界和平测试！');

  // clickPoint rejects invalid / zero-size rects explicitly
  await assert.rejects(() => page.clickPoint(null), /无效或零尺寸矩形/);
  await assert.rejects(() => page.clickPoint({ left: 10, top: 20, width: 0, height: 40 }), /无效或零尺寸矩形/);
  await assert.rejects(() => page.clickPoint({ x: 10, y: 20, width: 100, height: 0 }), /无效或零尺寸矩形/);

  // Newline handling: contenteditable uses Shift+Enter; single-line <input> replaces \n with space;
  // typeTag on contenteditable uses moveToEndOfDocument on darwin
  let evalTargetMode = 'contenteditable';
  const richCalls = [];
  const richClient = {
    on: () => () => {},
    async send(method, params = {}) {
      richCalls.push({ method, params });
      if (method === 'Runtime.evaluate') {
        const expr = String(params.expression || '');
        if (expr.includes('window.innerWidth')) return { result: { value: { width: 1440, height: 900, scrollY: 0 } } };
        if (expr.includes('getBoundingClientRect')) {
          return {
            result: {
              value: {
                selector: '.editor',
                visible: true,
                disabled: false,
                left: 300,
                top: 250,
                x: 300,
                y: 250,
                width: 300,
                height: 80,
                tagName: evalTargetMode === 'input' ? 'input' : 'div',
                isContentEditable: evalTargetMode === 'contenteditable',
              },
            },
          };
        }
        if (expr.includes('document.activeElement')) {
          return {
            result: {
              value: {
                tagName: evalTargetMode === 'input' ? 'input' : 'div',
                isContentEditable: evalTargetMode === 'contenteditable',
              },
            },
          };
        }
        if (expr.includes('hit.el.isContentEditable')) {
          return { result: { value: evalTargetMode === 'contenteditable' } };
        }
        return { result: { value: null } };
      }
      return {};
    },
  };
  const richPage = new CdpPage(richClient, { sessionId: 's2', targetId: 't2', fastMode: true, rng: createSeededRng(202) });

  // 1) contenteditable newline -> Shift+Enter (modifiers: 8, type: 'keyDown')
  evalTargetMode = 'contenteditable';
  await richPage.fillText(['.editor'], 'L1\r\nL2', { clear: false });
  const ceEnter = richCalls.filter((c) => c.method === 'Input.dispatchKeyEvent' && c.params.key === 'Enter' && c.params.type === 'keyDown');
  assert.equal(ceEnter.length, 1, 'CRLF must emit exactly one newline Enter');
  assert.equal(ceEnter[0].params.modifiers, 8, 'contenteditable newline must use Shift+Enter (modifiers=8)');

  // 2) typeTag on contenteditable moves caret to end via moveToEndOfDocument on darwin (or Ctrl+End)
  const beforeTagIdx = richCalls.length;
  await richPage.typeTag(['.editor'], 'AI', { commitKey: 'Enter' });
  const tagCalls = richCalls.slice(beforeTagIdx);
  if (process.platform === 'darwin') {
    const moveEnd = tagCalls.find((c) => c.method === 'Input.dispatchKeyEvent' && Array.isArray(c.params.commands) && c.params.commands.includes('moveToEndOfDocument'));
    assert.ok(moveEnd, 'darwin typeTag must move caret with commands: ["moveToEndOfDocument"]');
  }

  // 3) single-line <input> replaces newlines with spaces so it never submits the <form>
  evalTargetMode = 'input';
  const beforeInputIdx = richCalls.length;
  await richPage.fillText(['.editor'], 'Title1\nTitle2', { clear: false });
  const inputCalls = richCalls.slice(beforeInputIdx);
  const inputEnters = inputCalls.filter((c) => c.method === 'Input.dispatchKeyEvent' && c.params.key === 'Enter');
  assert.equal(inputEnters.length, 0, 'single-line <input> must never emit Enter for newlines');
});

test('device-bound cookieFiles refusal by default (Douyin/XHS/X), allowUnsafeCookieInjection opt-in, no overwrite when logged in, and shouldKeepTabOpen', async (t) => {
  const { tmpDir, videoPath } = createTempMedia(t);
  const dataDir = path.join(tmpDir, 'data');

  const dyCookie = path.join(tmpDir, 'dy.cookie');
  const xhsCookie = path.join(tmpDir, 'xhs.cookie');
  const xCookie = path.join(tmpDir, 'x.cookie');
  const biliCookie = path.join(tmpDir, 'bili.cookie');
  fs.writeFileSync(dyCookie, 'sessionid=dy_secret; bd_ticket_guard_client_data=guard_secret\n', { mode: 0o600 });
  fs.writeFileSync(xhsCookie, 'web_session=xhs_secret\n', { mode: 0o600 });
  fs.writeFileSync(xCookie, 'auth_token=x_secret; cf_clearance=cf_secret\n', { mode: 0o600 });
  fs.writeFileSync(biliCookie, 'SESSDATA=bili_secret\n', { mode: 0o600 });

  assert.ok(DEVICE_BOUND_COOKIE_PLATFORMS.has('douyin'));
  assert.ok(DEVICE_BOUND_COOKIE_PLATFORMS.has('xiaohongshu'));
  assert.ok(DEVICE_BOUND_COOKIE_PLATFORMS.has('x'));
  assert.equal(DEVICE_BOUND_COOKIE_PLATFORMS.has('bilibili'), false);

  // 1. shouldKeepTabOpen covers form_populated, composer_populated, keepTabOpen, needs_verification, needs_login
  assert.equal(shouldKeepTabOpen('xiaohongshu', { status: 'draft_saved', diagnostics: { draftMethod: 'form_populated' } }), true);
  assert.equal(shouldKeepTabOpen('douyin', { status: 'draft_saved', diagnostics: { draftMethod: 'composer_populated' } }), true);
  assert.equal(shouldKeepTabOpen('douyin', { status: 'draft_saved', diagnostics: { keepTabOpen: true } }), true);
  assert.equal(shouldKeepTabOpen('douyin', { status: 'needs_verification', diagnostics: {} }), true);
  assert.equal(shouldKeepTabOpen('douyin', { status: 'needs_login', diagnostics: {} }), true);
  assert.equal(shouldKeepTabOpen('bilibili', { status: 'draft_saved', diagnostics: { draftMethod: 'form_populated' } }), true);
  assert.equal(shouldKeepTabOpen('douyin', { status: 'published', diagnostics: {} }), false);

  // 2. check_accounts with cookieFiles on NOT-logged-in persistent profile
  const createdPages = [];
  const makeSessionFactory = ({ loggedInPlatforms = [] } = {}) => async () => ({
    source: 'mock_cdp',
    profileDir: path.join(tmpDir, 'profile'),
    async newPage() {
      const page = createMockPage({
        onNavigate: (st, url) => {
          const isLoggedIn = (
            (url.includes('douyin') && loggedInPlatforms.includes('douyin')) ||
            (url.includes('xiaohongshu') && loggedInPlatforms.includes('xiaohongshu')) ||
            (url.includes('x.com') && loggedInPlatforms.includes('x')) ||
            (url.includes('bilibili') && loggedInPlatforms.includes('bilibili')) ||
            st.cookies.length > 0
          );
          if (isLoggedIn) {
            st.currentUrl = url;
            st.visibleSelectors = new Set([
              'input[type="file"][accept*="video"]',
              'input.upload-input',
              '[data-testid="tweetTextarea_0"]',
              '.bcc-upload-wrapper input[type="file"]',
            ]);
          } else if (url.includes('douyin')) {
            st.currentUrl = 'https://creator.douyin.com/';
            st.visibleSelectors = new Set(['.login-guide-btn']);
          } else if (url.includes('xiaohongshu')) {
            st.currentUrl = 'https://creator.xiaohongshu.com/login';
            st.visibleSelectors = new Set(['.login-container']);
          } else if (url.includes('x.com')) {
            st.currentUrl = 'https://x.com/i/flow/login';
            st.visibleSelectors = new Set(['input[autocomplete="username"]']);
          } else if (url.includes('bilibili')) {
            st.currentUrl = 'https://passport.bilibili.com/login';
            st.visibleSelectors = new Set(['.login-scan-wp']);
          }
        },
      });
      createdPages.push(page);
      return page;
    },
    keepTargetOpen() {},
    async close() {},
  });

  // Default: refuses Douyin, XHS, X; allows Bilibili when not yet logged in
  const svc1 = createPublisherService({
    dataDir,
    sessionFactory: makeSessionFactory({ loggedInPlatforms: [] }),
    probeMediaFile: (file, opts) => probeMediaFile(file, { ...opts, skipFfprobe: true }),
  });
  const checkDefault = await svc1.callTool('check_accounts', {
    platforms: ['douyin', 'xiaohongshu', 'x', 'bilibili'],
    cookieFiles: { douyin: dyCookie, xiaohongshu: xhsCookie, x: xCookie, bilibili: biliCookie },
  });
  assert.equal(checkDefault.ok, true);
  const byPlat = Object.fromEntries(checkDefault.accounts.map((a) => [a.platform, a]));
  for (const blockedPlat of ['douyin', 'xiaohongshu', 'x']) {
    assert.equal(byPlat[blockedPlat].loggedIn, false, `${blockedPlat} must not inject cookieFiles by default`);
    assert.equal(byPlat[blockedPlat].status, 'needs_login');
    assert.equal(byPlat[blockedPlat].cookieInjectionBlocked, true);
    assert.match(byPlat[blockedPlat].message, /open_login/);
  }
  assert.equal(byPlat.bilibili.loggedIn, true, 'non-device-bound bilibili injects cookie when not logged in');

  // allowUnsafeCookieInjection: true injects when NOT logged in
  const checkUnsafe = await svc1.callTool('check_accounts', {
    platforms: ['douyin'],
    cookieFiles: { douyin: dyCookie },
    allowUnsafeCookieInjection: true,
  });
  assert.equal(checkUnsafe.accounts[0].loggedIn, true);
  assert.equal(checkUnsafe.accounts[0].cookieInjectionBlocked, undefined);

  // Even with allowUnsafeCookieInjection: true (or on bilibili), NEVER overwrite an already-logged-in persistent profile!
  createdPages.length = 0;
  const svcLoggedIn = createPublisherService({
    dataDir,
    sessionFactory: makeSessionFactory({ loggedInPlatforms: ['douyin', 'bilibili'] }),
    probeMediaFile: (file, opts) => probeMediaFile(file, { ...opts, skipFfprobe: true }),
  });
  const checkAlreadyLoggedIn = await svcLoggedIn.callTool('check_accounts', {
    platforms: ['douyin', 'bilibili'],
    cookieFiles: { douyin: dyCookie, bilibili: biliCookie },
    allowUnsafeCookieInjection: true,
  });
  assert.equal(checkAlreadyLoggedIn.accounts[0].loggedIn, true);
  assert.equal(checkAlreadyLoggedIn.accounts[0].cookieInjectionSkipped, 'already_logged_in');
  assert.equal(checkAlreadyLoggedIn.accounts[1].loggedIn, true);
  assert.equal(checkAlreadyLoggedIn.accounts[1].cookieInjectionSkipped, 'already_logged_in');
  assert.equal(createdPages[0].state.cookies.length, 0, 'must NEVER re-inject cookies into already logged-in douyin profile');
  assert.equal(createdPages[1].state.cookies.length, 0, 'must NEVER re-inject cookies into already logged-in bilibili profile');

  // start_publish_job with Douyin cookieFiles (not logged in) refuses cookie injection & keeps login tab open
  const keptTabs = [];
  const svcJob = createPublisherService({
    dataDir,
    sessionFactory: async () => {
      const base = await makeSessionFactory({ loggedInPlatforms: [] })();
      return {
        ...base,
        keepTargetOpen(p) { keptTabs.push(p); },
      };
    },
    probeMediaFile: (file, opts) => probeMediaFile(file, { ...opts, skipFfprobe: true }),
  });
  const jobRes = await svcJob.callTool('start_publish_job', {
    videoPath,
    title: '抖音风控回归测试',
    platforms: ['douyin'],
    mode: 'draft',
    cookieFiles: { douyin: dyCookie },
    waitSeconds: 5,
  });
  assert.equal(jobRes.ok, true);
  assert.equal(jobRes.job.results[0].status, 'needs_login');
  assert.equal(jobRes.job.results[0].cookieInjectionBlocked, true);
  assert.match(jobRes.job.results[0].message, /open_login/);
  assert.equal(keptTabs.length, 1, 'needs_login tab must be kept open');
});

test('static stealth audit: zero data-svp-click DOM mutation and zero window.__svLastFileSelector leak across src/', () => {
  const srcRoot = path.join(PLUGIN_ROOT, 'src');
  const walk = (dir) => {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(full);
    }
    return out;
  };
  const files = walk(srcRoot);
  assert.ok(files.length >= 9);
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(content.includes('data-svp-click'), false, `Found forbidden data-svp-click in ${file}`);
    assert.equal(content.includes('__svLastFileSelector'), false, `Found forbidden __svLastFileSelector in ${file}`);
    assert.equal(content.includes('--disable-infobars'), false, `Found deprecated --disable-infobars in ${file}`);
  }
});

test('all 4 adapters: mid-flow forced logout & risk-control immediate abort + warmupUploadPage + form_populated keepTabOpen', async (t) => {
  const { tmpDir, videoPath } = createTempMedia(t);

  // 1. Douyin: exact incident reproduction — after setFiles, transcode poll sees forced kickout to /creator-micro/home
  {
    const dyAdapter = getAdapter('douyin');
    const dyKickPage = createMockPage({
      visibleSelectors: ['input[type="file"][accept*="video"]', '.upload-btn'],
      onSetFiles: (st) => {
        st.currentUrl = 'https://creator.douyin.com/creator-micro/home';
        st.pageText = '扫码登录 验证码登录';
      },
    });
    const res = await dyAdapter.publishVideo(dyKickPage, {
      videoPath,
      title: '抖音中途登出回归',
      mode: 'draft',
      screenshotDir: tmpDir,
      options: { pollIntervalMs: 1, uploadTimeoutMs: 5000 },
    });
    assert.equal(res.status, 'needs_login');
    assert.equal(res.diagnostics.keepTabOpen, true);
    assert.equal(res.diagnostics.riskReason, 'session_invalidated_mid_flow');
    assert.equal(res.diagnostics.uploadIterations, 1, 'must abort immediately on first poll tick without retrying');
    assert.ok(fs.existsSync(res.screenshotPath));
    // Verify warmupUploadPage ran idleDrift + hoverAny BEFORE setFiles!
    const driftIdx = dyKickPage.state.calls.findIndex((c) => c.method === 'idleDrift');
    const setFilesIdx = dyKickPage.state.calls.findIndex((c) => c.method === 'setFiles');
    assert.ok(driftIdx >= 0 && driftIdx < setFilesIdx, 'warmupUploadPage must run idleDrift before setFiles');
    // Must NEVER attempt fillText after kickout!
    assert.equal(dyKickPage.state.calls.some((c) => c.method === 'fillText'), false);
  }

  // 1b. Douyin risk-control banner mid-flow
  {
    const dyAdapter = getAdapter('douyin');
    const dyRiskPage = createMockPage({
      visibleSelectors: ['input[type="file"][accept*="video"]'],
      onSetFiles: (st) => {
        st.pageText = '操作过于频繁，账号存在异常，请稍后再试';
      },
    });
    const res = await dyAdapter.publishVideo(dyRiskPage, {
      videoPath,
      title: '抖音风控弹窗回归',
      mode: 'draft',
      screenshotDir: tmpDir,
      options: { pollIntervalMs: 1, uploadTimeoutMs: 5000 },
    });
    assert.equal(res.status, 'needs_verification');
    assert.equal(res.diagnostics.keepTabOpen, true);
    assert.equal(res.diagnostics.riskReason, 'risk_control_banner');
    assert.equal(res.diagnostics.uploadIterations, 1);
  }

  // 2. Xiaohongshu: mid-flow session expired + form_populated keepTabOpen
  {
    const xhsAdapter = getAdapter('xiaohongshu');
    const xhsKickPage = createMockPage({
      visibleSelectors: ['input.upload-input'],
      onSetFiles: (st) => {
        st.pageText = '登录已过期，请重新登录';
      },
    });
    const kickRes = await xhsAdapter.publishVideo(xhsKickPage, {
      videoPath,
      title: '小红书中途过期',
      mode: 'draft',
      screenshotDir: tmpDir,
      options: { pollIntervalMs: 1, uploadTimeoutMs: 5000 },
    });
    assert.equal(kickRes.status, 'needs_login');
    assert.equal(kickRes.diagnostics.keepTabOpen, true);
    assert.equal(kickRes.diagnostics.riskReason, 'session_invalidated_mid_flow');
    assert.equal(xhsKickPage.state.calls.some((c) => c.method === 'fillText'), false);

    // XHS draft button missing -> form_populated MUST set keepTabOpen = true
    const xhsFormOnly = createMockPage({
      visibleSelectors: ['input.upload-input', 'input[placeholder*="填写标题"]', '.ql-editor', '.reupload-btn'],
    });
    const formRes = await xhsAdapter.publishVideo(xhsFormOnly, {
      videoPath,
      title: '小红书预填保活',
      description: '正文内容',
      mode: 'draft',
      screenshotDir: tmpDir,
      options: { pollIntervalMs: 1 },
    });
    assert.equal(formRes.status, 'draft_saved');
    assert.equal(formRes.diagnostics.draftMethod, 'form_populated');
    assert.equal(formRes.diagnostics.keepTabOpen, true);
    assert.equal(shouldKeepTabOpen('xiaohongshu', formRes), true);
  }

  // 3. X (Twitter): mid-flow Arkose/challenge abort during media attachment wait
  {
    const xAdapter = getAdapter('x');
    const xRiskPage = createMockPage({
      visibleSelectors: ['input[data-testid="fileInput"]', '[data-testid="tweetTextarea_0"]'],
      onSetFiles: (st) => {
        st.currentUrl = 'https://x.com/account/access';
        st.pageText = 'Verify you are human';
      },
    });
    const res = await xAdapter.publishVideo(xRiskPage, {
      videoPath,
      description: 'X challenge mid-flow',
      mode: 'draft',
      screenshotDir: tmpDir,
      options: { pollIntervalMs: 1, uploadTimeoutMs: 5000 },
    });
    assert.equal(res.status, 'needs_verification');
    assert.equal(res.diagnostics.keepTabOpen, true);
    assert.equal(xRiskPage.state.calls.some((c) => c.method === 'fillText'), false);
  }

  // 4. Bilibili: mid-flow forced logout & geetest risk abort during upload wait
  {
    const biliAdapter = getAdapter('bilibili');
    const biliKickPage = createMockPage({
      visibleSelectors: ['.bcc-upload-wrapper input[type="file"]'],
      onSetFiles: (st) => {
        st.currentUrl = 'https://passport.bilibili.com/login';
        st.visibleSelectors.add('.login-scan-wp');
      },
    });
    const kickRes = await biliAdapter.publishVideo(biliKickPage, {
      videoPath,
      title: 'B站中途登出',
      tags: ['AI'],
      mode: 'draft',
      screenshotDir: tmpDir,
      options: { pollIntervalMs: 1, uploadTimeoutMs: 5000 },
    });
    assert.equal(kickRes.status, 'needs_login');
    assert.equal(kickRes.diagnostics.keepTabOpen, true);
    assert.equal(kickRes.diagnostics.riskReason, 'session_invalidated_mid_flow');
    assert.equal(biliKickPage.state.calls.some((c) => c.method === 'fillText'), false);

    const biliRiskPage = createMockPage({
      visibleSelectors: ['.bcc-upload-wrapper input[type="file"]'],
      onSetFiles: (st) => {
        st.visibleSelectors.add('.geetest_panel');
        st.pageText = '请完成安全验证';
      },
    });
    const riskRes = await biliAdapter.publishVideo(biliRiskPage, {
      videoPath,
      title: 'B站中途滑块风控',
      tags: ['AI'],
      mode: 'draft',
      screenshotDir: tmpDir,
      options: { pollIntervalMs: 1, uploadTimeoutMs: 5000 },
    });
    assert.equal(riskRes.status, 'needs_verification');
    assert.equal(riskRes.diagnostics.keepTabOpen, true);
  }
});

test('guard false-positive regression: Douyin normal safety widget text and user-typed/X-timeline text never trigger false abort', async () => {
  // (a) Douyin normal logged-in editor page containing "作品安全检测" / "内容安全检测" must NOT abort
  const normalDouyinPage = createMockPage({
    initialUrl: 'https://creator.douyin.com/creator-micro/content/post/video?enter_from=publish_page',
    initialText: '发布视频 作品标题 作品安全检测：未见异常 内容安全检测已开启 重新上传 发布',
    visibleSelectors: ['input[placeholder*="填写作品标题"]', '.zone-container'],
  });
  const normalGuard = await checkPageGuardState(normalDouyinPage, {
    platformName: '抖音',
    stage: 'pre_submit',
    inFlow: true,
    isLoginUrl: (u) => /creator\.douyin\.com\/?$|\/creator-micro\/home/i.test(u),
    loginSelectors: ['.login-guide-btn'],
  });
  assert.equal(normalGuard.blocked, false, `Normal Douyin editor page must not false-abort: ${JSON.stringify(normalGuard)}`);

  // (b) readGuardPageText + checkPageGuardState with createTreeWalker skips [contenteditable="true"]
  //     and article[data-testid="tweet"], while STILL catching real outside-editor risk modals!
  function createTreeWalkerMockPage({ url, nodes }) {
    const fakeDocument = {
      body: { innerText: nodes.map((n) => n.text).join('\n') },
      createTreeWalker(_root, _whatToShow, filter) {
        let idx = 0;
        return {
          nextNode() {
            while (idx < nodes.length) {
              const item = nodes[idx++];
              const parentEl = {
                tagName: item.tag || 'DIV',
                isContentEditable: Boolean(item.contentEditable),
                parentElement: item.parentEl || null,
                getAttribute: (name) => (item.attrs && name in item.attrs ? item.attrs[name] : null),
              };
              const textNode = { nodeValue: item.text, parentElement: parentEl, parentNode: parentEl };
              const verdict = filter && typeof filter.acceptNode === 'function' ? filter.acceptNode(textNode) : 1;
              if (verdict === 1) return textNode;
            }
            return null;
          },
        };
      },
    };
    return {
      async url() { return url; },
      async queryAny() { return { selector: null, found: false, visible: false, text: '', disabled: false }; },
      async evaluate(fn, ...args) {
        const runner = new Function('document', 'NodeFilter', 'args', `return (${fn.toString()})(...args);`);
        return runner(fakeDocument, { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_SKIP: 3 }, args);
      },
    };
  }

  const tweetParent = {
    tagName: 'ARTICLE',
    isContentEditable: false,
    parentElement: null,
    getAttribute: (name) => (name === 'data-testid' ? 'tweet' : null),
  };

  // User-typed copy in contenteditable & background X timeline tweet mentioning风控/captcha/Verify you are human/验证码
  const safeTreePage = createTreeWalkerMockPage({
    url: 'https://x.com/compose/post',
    nodes: [
      { tag: 'DIV', text: 'Post composer ready' },
      { tag: 'DIV', contentEditable: true, attrs: { contenteditable: 'true' }, text: '分享如何避免触发风控、请完成安全验证、Verify you are human、请输入验证码、captcha' },
      { tag: 'SPAN', parentEl: tweetParent, text: 'Background timeline tweet: Verify you are human! 触发风控 扫码登录 请完成安全验证' },
    ],
  });

  const guardText = await readGuardPageText(safeTreePage);
  assert.equal(guardText, 'Post composer ready');
  const safeCheck = await checkPageGuardState(safeTreePage, {
    platformName: 'X',
    stage: 'pre_submit',
    inFlow: true,
  });
  assert.equal(safeCheck.blocked, false, 'Text inside contenteditable or background tweet article must not trigger guard');

  // Genuine outside-editor verification modal MUST still be caught!
  const realModalPage = createTreeWalkerMockPage({
    url: 'https://creator.douyin.com/creator-micro/content/post/video',
    nodes: [
      { tag: 'DIV', contentEditable: true, attrs: { contenteditable: 'true' }, text: '正常视频简介' },
      { tag: 'DIV', text: '请完成安全验证，请输入短信验证码' },
    ],
  });
  const modalCheck = await checkPageGuardState(realModalPage, {
    platformName: '抖音',
    stage: 'post_submit',
    inFlow: true,
  });
  assert.equal(modalCheck.blocked, true);
  assert.equal(modalCheck.status, 'needs_verification');
});
