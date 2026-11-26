import {
  buildResult,
  captureScreenshot,
  detectVerificationPrompt,
  humanDelay,
  normalizeTags,
  readPageText,
  reportProgress,
  safeQueryAny,
  validateCommonMedia,
  validateScheduleWindow,
} from './base.mjs';

export const spec = Object.freeze({
  id: 'x',
  name: '推特 (X)',
  loginUrl: 'https://x.com/i/flow/login',
  uploadUrl: 'https://x.com/compose/post',
  limits: Object.freeze({
    titleMax: 0,
    descriptionMax: 280,
    premiumDescriptionMax: 25000,
    maxTags: 5,
    maxFileSizeMb: 512,
    maxDurationSec: 140,
    scheduleMinMinutes: 0,
    scheduleMaxDays: 0,
  }),
  capabilities: Object.freeze({
    draft: true,
    publish: true,
    schedule: false,
    cover: false,
    tags: true,
    originalFlag: false,
    aiGeneratedFlag: false,
    visibility: false,
  }),
});

const LOGIN_SELECTORS = [
  'input[autocomplete="username"]',
  '[data-testid="loginButton"]',
  'a[href="/login"]',
  'a[href="/i/flow/login"]',
];

const VIDEO_INPUT_SELECTORS = [
  'input[data-testid="fileInput"]',
  'input[type="file"][accept*="video"]',
  'input[type="file"]',
];

const ATTACHMENT_SELECTORS = [
  '[data-testid="attachments"]',
  '[data-testid="videoPlayer"]',
  '[data-testid="mediaPreview"]',
  'video',
];

const TEXTAREA_SELECTORS = [
  '[data-testid="tweetTextarea_0"]',
  'div[role="textbox"][data-testid*="tweetTextarea"]',
  'div[role="textbox"][contenteditable="true"]',
];

const POST_BUTTON_SELECTORS = [
  '[data-testid="tweetButton"]',
  '[data-testid="tweetButtonInline"]',
];

const AUTH_INDICATOR_SELECTORS = [
  '[data-testid="tweetTextarea_0"]',
  'input[data-testid="fileInput"]',
  '[data-testid="SideNav_AccountSwitcher_Button"]',
  '[data-testid="SideNav_NewTweet_Button"]',
];

const X_URL_WEIGHT = 23;
const URL_REGEX = /https?:\/\/[^\s]+/gi;

/**
 * Compute X/Twitter weighted character weight for a single Unicode code point.
 * Standard Latin/ASCII counts as 1; CJK, fullwidth punctuation, and emoji count as 2.
 *
 * @param {number} cp
 * @returns {number}
 */
function xCodePointWeight(cp) {
  if (cp <= 0x10ff) return 1;
  if (cp >= 0x2000 && cp <= 0x200d) return 1;
  if (cp >= 0x2010 && cp <= 0x201f) return 1;
  if (cp >= 0x2032 && cp <= 0x2037) return 1;
  return 2;
}

/**
 * Compute weighted length according to X/Twitter's text-length rules.
 *
 * @param {string} text
 * @returns {number}
 */
export function computeXWeightedLength(text) {
  if (!text) return 0;
  let total = 0;
  let lastIndex = 0;
  URL_REGEX.lastIndex = 0;
  let match;

  while ((match = URL_REGEX.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    for (const ch of before) {
      total += xCodePointWeight(ch.codePointAt(0) || 0);
    }
    total += X_URL_WEIGHT;
    lastIndex = match.index + match[0].length;
  }

  const tail = text.slice(lastIndex);
  for (const ch of tail) {
    total += xCodePointWeight(ch.codePointAt(0) || 0);
  }
  return total;
}

/**
 * Clamp text to an X weighted character limit without splitting surrogate pairs.
 *
 * @param {string} text
 * @param {number} maxWeight
 * @returns {string}
 */
function clampXWeightedText(text, maxWeight) {
  if (!text || maxWeight <= 0) return '';
  if (computeXWeightedLength(text) <= maxWeight) return text;
  let used = 0;
  let out = '';
  for (const ch of text) {
    const w = xCodePointWeight(ch.codePointAt(0) || 0);
    if (used + w > maxWeight) break;
    used += w;
    out += ch;
  }
  return out.trimEnd();
}

/**
 * Merge title, description, and normalized hashtags cleanly into a single X post body.
 *
 * @param {string} title
 * @param {string} description
 * @param {string[]} tags
 * @returns {string}
 */
function composeTweetText(title, description, tags) {
  const cleanTitle = (title || '').trim();
  const cleanDesc = (description || '').trim();

  let body = '';
  if (cleanTitle && cleanDesc) {
    body = cleanDesc.startsWith(cleanTitle) ? cleanDesc : `${cleanTitle}\n\n${cleanDesc}`;
  } else {
    body = cleanTitle || cleanDesc;
  }

  const existingHashtags = new Set(
    Array.from(body.matchAll(/#([^\s#]+)/g)).map((m) => m[1].toLowerCase())
  );

  const missingTagStrings = [];
  for (const tag of tags) {
    const token = tag.replace(/\s+/g, '');
    if (!token) continue;
    if (existingHashtags.has(token.toLowerCase())) continue;
    existingHashtags.add(token.toLowerCase());
    missingTagStrings.push(`#${token}`);
  }

  if (missingTagStrings.length === 0) return body;
  const tagLine = missingTagStrings.join(' ');
  return body ? `${body}\n\n${tagLine}` : tagLine;
}

export function validate(payload) {
  const errors = [];
  const warnings = [];
  validateCommonMedia(payload, spec, errors, warnings);

  const options = payload?.options && typeof payload.options === 'object' ? { ...payload.options } : {};
  const isPremium = Boolean(options.xPremium);
  const charLimit = isPremium ? spec.limits.premiumDescriptionMax : spec.limits.descriptionMax;

  const rawTitle = payload?.title != null ? String(payload.title).trim() : '';
  const rawDesc = payload?.description != null ? String(payload.description).trim() : '';
  const rawTags = Array.isArray(payload?.tags)
    ? payload.tags
    : payload?.tags
      ? String(payload.tags).split(/[\n,，、]+/)
      : [];

  const tags = normalizeTags(rawTags, spec.limits.maxTags);
  const allUniqueTags = normalizeTags(rawTags, Infinity);
  if (allUniqueTags.length > spec.limits.maxTags) {
    warnings.push(`推特 (X) 建议最多保留 ${spec.limits.maxTags} 个话题标签，已保留前 ${spec.limits.maxTags} 个`);
  }

  const mergedRaw = composeTweetText(rawTitle, rawDesc, tags);
  const rawWeightedLength = computeXWeightedLength(mergedRaw);
  let tweetText = mergedRaw;

  if (rawWeightedLength > charLimit) {
    if (!isPremium) {
      warnings.push(
        `合并后的推文加权长度为 ${rawWeightedLength}，超出标准 X 账号 ${spec.limits.descriptionMax} 字符上限（中文/Emoji 计 2 字符），已自动截断；如为 X Premium 账号请设置 options.xPremium=true`
      );
    } else {
      warnings.push(`合并后的推文加权长度为 ${rawWeightedLength}，超出 X Premium ${charLimit} 字符上限，已自动截断`);
    }
    tweetText = clampXWeightedText(mergedRaw, charLimit);
  }

  const scheduleCheck = validateScheduleWindow(
    payload?.scheduleAt,
    spec.limits.scheduleMinMinutes,
    spec.limits.scheduleMaxDays
  );
  if (!scheduleCheck.valid && scheduleCheck.error) {
    errors.push(scheduleCheck.error);
  }

  if (options.original === true) {
    warnings.push('推特 (X) 不支持原创声明开关，已忽略 options.original');
  }
  if (options.aiGenerated === true) {
    warnings.push('推特 (X) 网页发布器不支持 AI 声明开关，已忽略 options.aiGenerated');
  }
  if (options.visibility) {
    warnings.push('推特 (X) 暂不支持通过本适配器设置可见性范围，已忽略 options.visibility');
  }

  const adapted = {
    title: '',
    description: tweetText,
    tweetText,
    weightedLength: computeXWeightedLength(tweetText),
    charLimit,
    tags,
    coverPath: null,
    scheduleAt: null,
    mode: payload?.mode === 'publish' ? 'publish' : 'draft',
    options,
  };

  return {
    ok: errors.length === 0,
    valid: errors.length === 0,
    errors,
    warnings,
    normalized: adapted,
    adapted,
  };
}

function isXLoginUrl(url) {
  return typeof url === 'string' && /\/i\/flow\/login|\/login(?:[/?#]|$)/i.test(url);
}

function isXChallengeUrl(url) {
  return typeof url === 'string' && /\/account\/access|\/i\/flow\/consent|arkose/i.test(url);
}

export async function checkAuth(page) {
  await page.navigate(spec.uploadUrl, { timeoutMs: 30_000 });
  await humanDelay(600, 1100, page);

  const currentUrl = (await page.url()) || '';
  const pageText = await readPageText(page);
  const verify = detectVerificationPrompt(pageText);

  if (isXChallengeUrl(currentUrl) || verify.detected) {
    return {
      platform: spec.id,
      loggedIn: false,
      status: 'needs_verification',
      handle: null,
      accountName: null,
      url: currentUrl,
      message: `X (Twitter) 触发账号安全验证（${verify.kind || 'challenge'}），请先在浏览器完成验证`,
      diagnostics: { verification: verify },
    };
  }

  const loginDom = await safeQueryAny(page, LOGIN_SELECTORS);
  if (isXLoginUrl(currentUrl) || (loginDom.found && loginDom.visible)) {
    return {
      platform: spec.id,
      loggedIn: false,
      status: 'needs_login',
      handle: null,
      accountName: null,
      url: currentUrl,
      message: 'X (Twitter) 未登录，请先调用 open_login 登录账号',
      diagnostics: { loginSelector: loginDom.selector },
    };
  }

  const authDom = await safeQueryAny(page, AUTH_INDICATOR_SELECTORS);
  const accountName = await extractAccountHandle(page);
  const loggedIn = authDom.found || Boolean(accountName);

  return {
    platform: spec.id,
    loggedIn,
    status: loggedIn ? 'logged_in' : 'needs_login',
    handle: accountName,
    accountName,
    url: currentUrl,
    message: loggedIn
      ? `X (Twitter) 已登录${accountName ? `（${accountName}）` : ''}`
      : '未能确认 X (Twitter) 登录状态，请先登录账号',
    diagnostics: { matchedSelector: authDom.selector },
  };
}

export async function openLogin(page) {
  await page.navigate(spec.loginUrl, { timeoutMs: 30_000 });
  await humanDelay(500, 900, page);
  const currentUrl = (await page.url()) || spec.loginUrl;
  const alreadyLoggedIn = !isXLoginUrl(currentUrl) && /https?:\/\/(x|twitter)\.com\/home/i.test(currentUrl);
  return {
    platform: spec.id,
    status: alreadyLoggedIn ? 'already_logged_in' : 'login_opened',
    url: currentUrl,
    loginUrl: spec.loginUrl,
    message: alreadyLoggedIn
      ? 'X (Twitter) 当前已处于登录状态'
      : '已打开 X (Twitter) 登录页，请在浏览器中完成登录',
    diagnostics: {},
  };
}

async function extractAccountHandle(page) {
  if (!page || typeof page.evaluate !== 'function') return null;
  try {
    const handle = await page.evaluate(() => {
      if (typeof document === 'undefined') return null;
      const btn = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
      if (btn) {
        const text = (btn.innerText || btn.textContent || '').trim();
        const match = text.match(/@[A-Za-z0-9_]+/);
        if (match) return match[0];
      }
      const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
      const href = profileLink ? profileLink.getAttribute('href') : null;
      if (href && /^\/[A-Za-z0-9_]+$/.test(href)) return `@${href.slice(1)}`;
      return null;
    });
    return typeof handle === 'string' && handle.trim() ? handle.trim() : null;
  } catch {
    return null;
  }
}

async function waitForMediaAttachmentReady(page, ctx, diagnostics) {
  const timeoutMs = ctx.options?.uploadTimeoutMs ?? 120_000;
  const pollIntervalMs = ctx.options?.pollIntervalMs ?? 1500;
  const deadline = Date.now() + timeoutMs;

  let iteration = 0;
  while (iteration === 0 || Date.now() < deadline) {
    iteration += 1;
    const currentUrl = (await page.url()) || '';
    const pageText = await readPageText(page);
    const verify = detectVerificationPrompt(pageText);
    if (isXChallengeUrl(currentUrl) || verify.detected) {
      return { state: 'needs_verification', verify };
    }

    if (/media file could not be processed|video is too long|file type is not supported|failed to upload|无法处理媒体/i.test(pageText)) {
      return { state: 'failed', reason: 'X 提示视频文件无法处理或超出格式/时长限制' };
    }

    const attachment = await safeQueryAny(page, ATTACHMENT_SELECTORS);
    const processingBar = await safeQueryAny(page, ['[role="progressbar"]', '[data-testid="mediaUploadProgress"]']);
    const stillProcessing =
      (processingBar.found && processingBar.visible) ||
      /uploading\s*\(\d+%\)|processing\s+video|正在上传\s*\d+%/i.test(pageText);

    if (attachment.found && !stillProcessing) {
      diagnostics.uploadIterations = iteration;
      diagnostics.attachmentSelector = attachment.selector;
      return { state: 'ready' };
    }

    if (Date.now() >= deadline) break;
    await page.sleep(pollIntervalMs);
  }

  return { state: 'timeout', reason: '等待 X 视频附件上传与处理完成超时' };
}

async function waitForPostButtonEnabled(page, ctx) {
  const timeoutMs = ctx.options?.enableButtonTimeoutMs ?? 30_000;
  const pollIntervalMs = ctx.options?.pollIntervalMs ?? 1000;
  const deadline = Date.now() + timeoutMs;

  let iteration = 0;
  while (iteration === 0 || Date.now() < deadline) {
    iteration += 1;
    const btn = await safeQueryAny(page, POST_BUTTON_SELECTORS);
    if (btn.found && !btn.disabled) {
      return { ready: true, selector: btn.selector };
    }
    if (Date.now() >= deadline) break;
    await page.sleep(pollIntervalMs);
  }
  return { ready: false, selector: null };
}

async function extractPublishedStatusUrl(page) {
  if (!page || typeof page.evaluate !== 'function') return null;
  try {
    const href = await page.evaluate(() => {
      if (typeof document === 'undefined') return null;
      const links = Array.from(document.querySelectorAll('a[href*="/status/"]'));
      for (const link of links) {
        const raw = link.getAttribute('href') || '';
        if (/\/status\/\d+/.test(raw)) {
          return raw.startsWith('http') ? raw : `https://x.com${raw}`;
        }
      }
      return null;
    });
    return typeof href === 'string' && href ? href : null;
  } catch {
    return null;
  }
}

export async function publishVideo(page, ctx) {
  const diagnostics = { steps: [] };
  const validation = validate(ctx);
  if (!validation.valid) {
    return buildResult({
      platform: spec.id,
      status: 'failed',
      message: `X (Twitter) 参数校验失败：${validation.errors.join('；')}`,
      diagnostics: { errors: validation.errors, warnings: validation.warnings },
    });
  }

  const { adapted, warnings } = validation;
  const mode = adapted.mode;
  diagnostics.warnings = warnings;
  diagnostics.mode = mode;
  diagnostics.weightedLength = adapted.weightedLength;
  diagnostics.charLimit = adapted.charLimit;

  try {
    reportProgress(ctx, spec.id, 'navigate', '正在打开 X (Twitter) 发布器');
    await page.navigate(spec.uploadUrl, { timeoutMs: 30_000 });
    await humanDelay(600, 1200, page);

    const currentUrl = (await page.url()) || '';
    const initialText = await readPageText(page);
    const initialVerify = detectVerificationPrompt(initialText);
    if (isXChallengeUrl(currentUrl) || initialVerify.detected) {
      const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, 'verification', diagnostics);
      return buildResult({
        platform: spec.id,
        status: 'needs_verification',
        url: currentUrl,
        screenshotPath,
        message: `X (Twitter) 触发安全验证（${initialVerify.kind || 'challenge'}），请先在浏览器完成验证`,
        diagnostics: { ...diagnostics, verification: initialVerify },
      });
    }

    const loginDom = await safeQueryAny(page, LOGIN_SELECTORS);
    if (isXLoginUrl(currentUrl) || (loginDom.found && loginDom.visible)) {
      const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, 'needs_login', diagnostics);
      return buildResult({
        platform: spec.id,
        status: 'needs_login',
        url: currentUrl,
        screenshotPath,
        message: 'X (Twitter) 未登录，请先登录后重试',
        diagnostics,
      });
    }

    // CRITICAL X QUIRK: Upload video FIRST before typing text so X doesn't clear composer text on media attach.
    reportProgress(ctx, spec.id, 'upload', '正在先上传视频附件到 X（避免文案被覆盖）');
    const fileRes = await page.setFiles(VIDEO_INPUT_SELECTORS, [ctx.videoPath]);
    diagnostics.steps.push({ step: 'upload_video_first', selector: fileRes?.selector || null });
    await humanDelay(500, 1000, page);

    reportProgress(ctx, spec.id, 'transcode', '正在等待 X 视频附件处理完成');
    const attachState = await waitForMediaAttachmentReady(page, ctx, diagnostics);
    if (attachState.state === 'needs_verification') {
      const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, 'verification', diagnostics);
      return buildResult({
        platform: spec.id,
        status: 'needs_verification',
        url: await page.url(),
        screenshotPath,
        message: 'X (Twitter) 在上传视频时要求安全验证，请在浏览器完成验证',
        diagnostics: { ...diagnostics, verification: attachState.verify },
      });
    }
    if (attachState.state !== 'ready') {
      const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, 'upload_failed', diagnostics);
      return buildResult({
        platform: spec.id,
        status: 'failed',
        url: await page.url(),
        screenshotPath,
        message: attachState.reason || 'X 视频上传未完成',
        diagnostics,
      });
    }

    // THEN fill tweet text into [data-testid="tweetTextarea_0"]
    if (adapted.tweetText) {
      reportProgress(ctx, spec.id, 'fill_text', '正在填入推文文案与标签');
      const fillRes = await page.fillText(TEXTAREA_SELECTORS, adapted.tweetText, { clear: true, humanJitter: true });
      diagnostics.steps.push({
        step: 'fill_tweet_text',
        selector: fillRes?.selector || null,
        weightedLength: adapted.weightedLength,
      });
      await humanDelay(300, 700, page);
    }

    // Draft mode: keep composer populated without clicking Post
    if (mode === 'draft') {
      reportProgress(ctx, spec.id, 'save_draft', '已填充 X 发布器（草稿预览态，不点击发布）');
      const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, 'draft_saved', diagnostics);
      diagnostics.draftMethod = 'composer_populated';
      return buildResult({
        platform: spec.id,
        status: 'draft_saved',
        url: await page.url(),
        screenshotPath,
        message: '视频与推文文案已填入 X 发布器（草稿预览状态，未点击 Post）',
        diagnostics,
      });
    }

    // Publish mode: wait until Post button is enabled, click, and verify confirmation / status URL
    reportProgress(ctx, spec.id, 'wait_post_button', '正在等待 X 发布按钮就绪');
    const postBtn = await waitForPostButtonEnabled(page, ctx);
    if (!postBtn.ready) {
      const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, 'post_btn_disabled', diagnostics);
      return buildResult({
        platform: spec.id,
        status: 'failed',
        url: await page.url(),
        screenshotPath,
        message: 'X 发布按钮仍处于禁用状态（视频可能仍在处理或文案超限），请查看截图确认',
        diagnostics,
      });
    }

    reportProgress(ctx, spec.id, 'publish', '正在提交发布 X 推文');
    await page.clickAny([postBtn.selector, ...POST_BUTTON_SELECTORS], { timeoutMs: 5000 });
    diagnostics.steps.push({ step: 'click_post', selector: postBtn.selector });

    const publishTimeoutMs = ctx.options?.publishTimeoutMs ?? 20_000;
    const pollIntervalMs = ctx.options?.pollIntervalMs ?? 1000;
    const deadline = Date.now() + publishTimeoutMs;
    let publishedConfirmed = false;
    let statusUrl = null;
    let finalUrl = (await page.url()) || '';

    let iter = 0;
    while (iter === 0 || Date.now() < deadline) {
      iter += 1;
      await page.sleep(pollIntervalMs);
      finalUrl = (await page.url()) || '';
      const afterText = await readPageText(page);
      const afterVerify = detectVerificationPrompt(afterText);

      if (isXChallengeUrl(finalUrl) || afterVerify.detected) {
        const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, 'verification', diagnostics);
        return buildResult({
          platform: spec.id,
          status: 'needs_verification',
          url: finalUrl,
          screenshotPath,
          message: `点击发布后 X 触发安全验证（${afterVerify.kind || 'challenge'}），请在浏览器中完成验证`,
          diagnostics: { ...diagnostics, verification: afterVerify },
        });
      }

      const extractedUrl = await extractPublishedStatusUrl(page);
      if (extractedUrl) {
        statusUrl = extractedUrl;
        publishedConfirmed = true;
        break;
      }

      if (/\/status\/\d+/.test(finalUrl)) {
        statusUrl = finalUrl;
        publishedConfirmed = true;
        break;
      }

      const toastOrClosed =
        /your post was sent|已发送你的帖子|post was sent/i.test(afterText) ||
        (!finalUrl.includes('/compose/post') && !(await safeQueryAny(page, TEXTAREA_SELECTORS)).visible);

      if (toastOrClosed) {
        publishedConfirmed = true;
        break;
      }

      if (Date.now() >= deadline) break;
    }

    const screenshotPath = await captureScreenshot(
      page,
      ctx.screenshotDir,
      spec.id,
      publishedConfirmed ? 'published' : 'publish_uncertain',
      diagnostics
    );

    if (!publishedConfirmed) {
      return buildResult({
        platform: spec.id,
        status: 'failed',
        url: finalUrl,
        screenshotPath,
        message: '已点击 X 发布按钮，但未检测到发送成功提示或推文链接，请查看截图确认',
        diagnostics,
      });
    }

    return buildResult({
      platform: spec.id,
      status: 'published',
      url: statusUrl || finalUrl,
      screenshotPath,
      message: statusUrl ? `X 推文发布成功：${statusUrl}` : 'X 推文发布成功',
      diagnostics,
    });
  } catch (err) {
    const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, 'error', diagnostics);
    return buildResult({
      platform: spec.id,
      status: 'failed',
      url: (await page.url().catch(() => null)) || null,
      screenshotPath,
      message: `X (Twitter) 发布过程异常：${err instanceof Error ? err.message : String(err)}`,
      diagnostics: { ...diagnostics, error: err instanceof Error ? err.message : String(err) },
    });
  }
}

export default {
  spec,
  validate,
  checkAuth,
  openLogin,
  publishVideo,
};
