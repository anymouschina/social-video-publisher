import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  PLUGIN_NAME,
  PLUGIN_VERSION,
  clampWaitSeconds,
  redactSensitiveText,
} from '../src/constants.mjs';
import {
  IN_PAGE_FINDER_SOURCE,
  discoverCdpCandidates,
  parseCookieFile,
} from '../src/cdp.mjs';
import { probeMediaFile } from '../src/media-probe.mjs';
import { LocalStorage } from '../src/storage.mjs';
import { TOOLS, createPublisherService } from '../src/server.mjs';
import {
  ADAPTERS,
  getAdapter,
  listPlatformSpecs,
  resolvePlatformId,
} from '../src/adapters/index.mjs';
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
      // 5. clickWithTextFallback text matcher
      if (src.includes('data-svp-click')) {
        const labels = Array.isArray(args[0]) ? args[0] : [];
        const matched = labels.find((l) => (config.clickableTextLabels || []).includes(l));
        if (matched) {
          state.calls.push({ method: 'clickText', label: matched });
          if (typeof config.onClickText === 'function') {
            config.onClickText(state, matched);
          }
          return matched;
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
  assert.equal(info.version, '0.1.0');
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
  assert.deepEqual(claudeTurn.names, ['social-video-publisher@0.1.0']);

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

  // Cookie was injected into XHS page, NEVER leaked into persisted storage files
  assert.equal(openedPages[0].state.cookies.length, 2);
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
