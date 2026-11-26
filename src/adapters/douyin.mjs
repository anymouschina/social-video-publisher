import {
  buildGuardAbortResult,
  buildResult,
  captureScreenshot,
  checkPageGuardState,
  clampText,
  clickWithTextFallback,
  formatScheduleLocal,
  humanDelay,
  humanPause,
  jitteredInterval,
  normalizeTags,
  readPageText,
  reportProgress,
  safeQueryAny,
  validateCommonMedia,
  validateScheduleWindow,
  warmupUploadPage,
} from './base.mjs';

export const spec = Object.freeze({
  id: 'douyin',
  name: '抖音',
  loginUrl: 'https://creator.douyin.com/',
  uploadUrl: 'https://creator.douyin.com/creator-micro/content/upload',
  limits: Object.freeze({
    titleMax: 30,
    descriptionMax: 1000,
    maxTags: 5,
    maxFileSizeMb: 16384,
    maxDurationSec: 1800,
    scheduleMinMinutes: 120,
    scheduleMaxDays: 14,
  }),
  capabilities: Object.freeze({
    draft: true,
    publish: true,
    schedule: true,
    cover: true,
    tags: true,
    originalFlag: false,
    aiGeneratedFlag: true,
    visibility: true,
  }),
});

const LOGIN_SELECTORS = [
  '.login-guide-btn',
  '.semi-modal-content input[placeholder*="手机号"]',
  '[class*="qrcode-login"]',
  'button.login-button',
];

const UPLOAD_DROPZONE_SELECTORS = [
  '[class*="upload-btn"]',
  '[class*="upload-drag"]',
  '[class*="container-drag"]',
  '.semi-upload-drag-area',
  'div[class*="upload"]',
];

const VIDEO_INPUT_SELECTORS = [
  'input[type="file"][accept*="video"]',
  '.upload-btn-input',
  'div[class*="upload"] input[type="file"]',
  'input[type="file"]',
];

const TITLE_SELECTORS = [
  'input[placeholder*="填写作品标题"]',
  'input[placeholder*="作品标题"]',
  'input[placeholder*="好的标题"]',
  'input.semi-input[maxlength="30"]',
  '.title-input input',
];

const DESC_SELECTORS = [
  '.zone-container',
  '[contenteditable="true"][data-placeholder*="作品简介"]',
  '[contenteditable="true"][data-placeholder*="添加作品简介"]',
  '.editor-kit-container [contenteditable="true"]',
  'div[contenteditable="true"]',
];

const TAG_SUGGESTION_SELECTORS = [
  '.mention-suggest-item',
  '.topic-suggest-item',
  '.semi-popover-content [class*="item"]',
];

const COVER_TRIGGER_SELECTORS = [
  '[class*="cover-select"]',
  '.cover-edit',
  '.select-cover-btn',
];

const COVER_UPLOAD_TAB_SELECTORS = [
  '[class*="upload-cover-tab"]',
  '.semi-tabs-tab[data-tab-key="upload"]',
];

const COVER_INPUT_SELECTORS = [
  '.semi-modal input[type="file"][accept*="image"]',
  'input[type="file"][accept*="image"]',
  '.cover-upload input[type="file"]',
];

const COVER_CONFIRM_SELECTORS = [
  '.semi-modal-footer button.semi-button-primary',
  '.cover-modal button.primary',
];

const SCHEDULE_INPUT_SELECTORS = [
  'input[placeholder*="日期和时间"]',
  'input[placeholder*="选择日期"]',
  '.semi-datepicker-input input',
];

const DRAFT_BUTTON_SELECTORS = [
  'button[class*="draft"]',
  '.content-confirm-container button.semi-button-tertiary',
];

const PUBLISH_BUTTON_SELECTORS = [
  'button[class*="publish-btn"]',
  '.content-confirm-container button.semi-button-primary',
  'button.button-dhlUZE',
];

const VERIFICATION_MODAL_SELECTORS = [
  '.uc-ui-verify',
  '.captcha_verify_container',
  '#captcha_container',
  '.secsdk-captcha-drag-wrapper',
  '#captcha-verify-image',
  'iframe[src*="verify"]',
  'iframe[src*="captcha"]',
  '[class*="verify-dialog"]',
  '[class*="sms-verify"]',
  '[class*="phone-verify"]',
];

const UPLOAD_READY_SELECTORS = [
  '[class*="reupload"]',
  '.preview-video',
  'video',
];

const VISIBILITY_LABELS = Object.freeze({
  public: ['公开（所有人可见）', '所有人可见', '公开'],
  private: ['仅自己可见', '私密'],
  friends: ['互相关注朋友可见', '好友可见'],
});

export function validate(payload) {
  const errors = [];
  const warnings = [];
  validateCommonMedia(payload, spec, errors, warnings);

  const rawTitle = payload?.title != null ? String(payload.title).trim() : '';
  const rawDesc = payload?.description != null ? String(payload.description).trim() : '';
  const rawTags = Array.isArray(payload?.tags)
    ? payload.tags
    : payload?.tags
      ? String(payload.tags).split(/[\n,，、]+/)
      : [];

  const title = clampText(rawTitle, spec.limits.titleMax);
  if (Array.from(rawTitle).length > spec.limits.titleMax) {
    warnings.push(`抖音标题上限为 ${spec.limits.titleMax} 字，已自动截断为：${title}`);
  }

  const description = clampText(rawDesc, spec.limits.descriptionMax);
  if (Array.from(rawDesc).length > spec.limits.descriptionMax) {
    warnings.push(`抖音作品简介上限为 ${spec.limits.descriptionMax} 字，已自动截断`);
  }

  const tags = normalizeTags(rawTags, spec.limits.maxTags);
  const allUniqueTags = normalizeTags(rawTags, Infinity);
  if (allUniqueTags.length > spec.limits.maxTags) {
    warnings.push(`抖音最多支持 ${spec.limits.maxTags} 个话题标签，已保留前 ${spec.limits.maxTags} 个`);
  }

  const scheduleCheck = validateScheduleWindow(
    payload?.scheduleAt,
    spec.limits.scheduleMinMinutes,
    spec.limits.scheduleMaxDays
  );
  if (!scheduleCheck.valid && scheduleCheck.error) {
    errors.push(scheduleCheck.error);
  }

  const options = payload?.options && typeof payload.options === 'object' ? { ...payload.options } : {};
  if (options.original === true) {
    warnings.push('抖音网页发布器不支持独立原创声明开关，已忽略 options.original');
  }
  if (options.visibility && !VISIBILITY_LABELS[options.visibility]) {
    errors.push(`抖音不支持可见性选项 visibility="${options.visibility}"，可选值：public / private / friends`);
  }

  const adapted = {
    title,
    description,
    tags,
    coverPath: payload?.coverPath || null,
    scheduleAt: scheduleCheck.iso,
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

function isDouyinLoginUrl(url, { inFlow = false } = {}) {
  if (typeof url !== 'string' || !url) return false;
  if (/passport\.douyin\.com|\/login(?:[/?#]|$)/i.test(url)) return true;
  // Unauthenticated creator-micro/content/upload redirects to root creator.douyin.com/
  if (/^https?:\/\/creator\.douyin\.com\/?(?:[?#].*)?$/i.test(url)) return true;
  // Mid-flow forced kickout bounces via creator.douyin.com/ into /creator-micro/home
  if (inFlow && /\/creator-micro\/home(?:[/?#]|$)/i.test(url)) return true;
  return false;
}

function checkDouyinGuard(page, { stage = 'flow', inFlow = false } = {}) {
  return checkPageGuardState(page, {
    platformName: spec.name,
    stage,
    inFlow,
    isLoginUrl: (url) => isDouyinLoginUrl(url, { inFlow }),
    loginSelectors: LOGIN_SELECTORS,
    verificationSelectors: VERIFICATION_MODAL_SELECTORS,
    extraLoginTextRegex: /我是创作者.*登录/,
  });
}

export async function checkAuth(page) {
  await page.navigate(spec.uploadUrl, { timeoutMs: 30_000 });
  await humanDelay(600, 1100, page);

  const guard = await checkDouyinGuard(page, { stage: 'check_auth', inFlow: false });
  if (guard.blocked) {
    return {
      platform: spec.id,
      loggedIn: false,
      status: guard.status,
      handle: null,
      accountName: null,
      url: guard.url,
      message: guard.message,
      diagnostics: guard.diagnostics,
    };
  }

  const currentUrl = guard.url || (await page.url()) || '';
  const uploadDom = await safeQueryAny(page, [...VIDEO_INPUT_SELECTORS, ...TITLE_SELECTORS]);
  const accountName = await extractAccountName(page);
  const loggedIn = currentUrl.includes('creator.douyin.com/creator-micro') && (uploadDom.found || Boolean(accountName));

  return {
    platform: spec.id,
    loggedIn,
    status: loggedIn ? 'logged_in' : 'needs_login',
    handle: accountName,
    accountName,
    url: currentUrl,
    message: loggedIn
      ? `抖音创作者平台已登录${accountName ? `（${accountName}）` : ''}`
      : '未能确认抖音登录状态，请先登录抖音创作者平台',
    diagnostics: { matchedSelector: uploadDom.selector },
  };
}

export async function openLogin(page) {
  await page.navigate(spec.loginUrl, { timeoutMs: 30_000 });
  await humanDelay(500, 900, page);
  const currentUrl = (await page.url()) || spec.loginUrl;
  const alreadyLoggedIn = currentUrl.includes('/creator-micro/');
  return {
    platform: spec.id,
    status: alreadyLoggedIn ? 'already_logged_in' : 'login_opened',
    url: currentUrl,
    loginUrl: spec.loginUrl,
    message: alreadyLoggedIn
      ? '抖音创作者平台当前已处于登录状态'
      : '已打开抖音创作者平台登录页，请在浏览器中完成扫码或手机验证登录',
    diagnostics: {},
  };
}

async function extractAccountName(page) {
  if (!page || typeof page.evaluate !== 'function') return null;
  try {
    const name = await page.evaluate(() => {
      if (typeof document === 'undefined') return null;
      const selectors = [
        '.header-right-name',
        '[class*="user-name"]',
        '[class*="nickname"]',
        '.creator-header-name',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        const text = el && (el.innerText || el.textContent || '').trim();
        if (text && text.length <= 40) return text;
      }
      return null;
    });
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

async function waitForEditorAndTranscode(page, ctx, diagnostics) {
  const timeoutMs = ctx.options?.uploadTimeoutMs ?? 180_000;
  const pollIntervalMs = ctx.options?.pollIntervalMs ?? 1800;
  const deadline = Date.now() + timeoutMs;

  let iteration = 0;
  while (iteration === 0 || Date.now() < deadline) {
    iteration += 1;

    // Run risk-control & mid-flow forced-logout guard on EVERY SINGLE POLL ITERATION
    const guard = await checkDouyinGuard(page, { stage: 'transcode', inFlow: true });
    if (guard.blocked) {
      diagnostics.uploadIterations = iteration;
      return { state: 'guard_blocked', guard };
    }

    const pageText = await readPageText(page);
    if (/上传失败|转码失败|视频格式不支持/.test(pageText)) {
      return { state: 'failed', reason: '抖音提示视频上传或转码失败' };
    }

    const titleEl = await safeQueryAny(page, TITLE_SELECTORS);
    const descEl = await safeQueryAny(page, DESC_SELECTORS);
    const readyEl = await safeQueryAny(page, UPLOAD_READY_SELECTORS);
    const hasReupload = /重新上传|更换视频|上传成功/.test(pageText);
    const stillUploading = /上传中|正在上传|转码中/.test(pageText) && !hasReupload;

    if ((titleEl.found || descEl.found) && !stillUploading && (hasReupload || readyEl.found)) {
      diagnostics.uploadIterations = iteration;
      return { state: 'ready' };
    }

    if (Date.now() >= deadline) break;
    await page.sleep(jitteredInterval(pollIntervalMs));
  }

  return { state: 'timeout', reason: '等待抖音视频上传与转码完成超时' };
}

export async function publishVideo(page, ctx) {
  const diagnostics = { steps: [] };
  const validation = validate(ctx);
  if (!validation.valid) {
    return buildResult({
      platform: spec.id,
      status: 'failed',
      message: `抖音参数校验失败：${validation.errors.join('；')}`,
      diagnostics: { errors: validation.errors, warnings: validation.warnings },
    });
  }

  const { adapted, warnings } = validation;
  const mode = adapted.mode;
  diagnostics.warnings = warnings;
  diagnostics.mode = mode;

  try {
    reportProgress(ctx, spec.id, 'navigate', '正在打开抖音视频上传页');
    await page.navigate(spec.uploadUrl, { timeoutMs: 30_000 });
    await humanDelay(600, 1200, page);

    const postNavGuard = await checkDouyinGuard(page, { stage: 'post_navigate', inFlow: false });
    if (postNavGuard.blocked) {
      return buildGuardAbortResult(page, ctx, spec, postNavGuard, diagnostics);
    }

    // Natural page warmup (1.8–3.5s dwell + cursor drift + dropzone hover) before attaching file
    await warmupUploadPage(page, UPLOAD_DROPZONE_SELECTORS);

    reportProgress(ctx, spec.id, 'upload', '正在上传视频到抖音');
    const fileRes = await page.setFiles(VIDEO_INPUT_SELECTORS, [ctx.videoPath]);
    diagnostics.steps.push({ step: 'upload_file', selector: fileRes?.selector || null });
    await humanPause(page, 900, 1800);

    reportProgress(ctx, spec.id, 'transcode', '正在等待抖音发布表单与视频转码就绪');
    const uploadState = await waitForEditorAndTranscode(page, ctx, diagnostics);
    if (uploadState.state === 'guard_blocked') {
      return buildGuardAbortResult(page, ctx, spec, uploadState.guard, diagnostics);
    }
    if (uploadState.state !== 'ready') {
      const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, 'upload_failed', diagnostics);
      return buildResult({
        platform: spec.id,
        status: 'failed',
        url: await page.url(),
        screenshotPath,
        message: uploadState.reason || '抖音视频上传未完成',
        diagnostics,
      });
    }

    // Pre-fill guard check + natural reading transition pause
    const preFillGuard = await checkDouyinGuard(page, { stage: 'pre_fill', inFlow: true });
    if (preFillGuard.blocked) {
      return buildGuardAbortResult(page, ctx, spec, preFillGuard, diagnostics);
    }
    await humanPause(page, 900, 2000);

    // Fill title (<= 30 chars)
    if (adapted.title) {
      reportProgress(ctx, spec.id, 'fill_title', '正在填写抖音作品标题');
      await page.fillText(TITLE_SELECTORS, adapted.title, { clear: true, humanJitter: true });
      diagnostics.steps.push({ step: 'fill_title', length: Array.from(adapted.title).length });
      await humanPause(page, 900, 2000);
    }

    // Fill description
    if (adapted.description) {
      const preDescGuard = await checkDouyinGuard(page, { stage: 'pre_fill_description', inFlow: true });
      if (preDescGuard.blocked) {
        return buildGuardAbortResult(page, ctx, spec, preDescGuard, diagnostics);
      }
      reportProgress(ctx, spec.id, 'fill_description', '正在填写抖音作品简介');
      await page.fillText(DESC_SELECTORS, adapted.description, { clear: true, humanJitter: true });
      diagnostics.steps.push({ step: 'fill_description', length: Array.from(adapted.description).length });
      await humanPause(page, 1100, 2400);
    }

    // Fill #tags (<= 5)
    if (adapted.tags.length > 0) {
      const preTagsGuard = await checkDouyinGuard(page, { stage: 'pre_fill_tags', inFlow: true });
      if (preTagsGuard.blocked) {
        return buildGuardAbortResult(page, ctx, spec, preTagsGuard, diagnostics);
      }
      reportProgress(ctx, spec.id, 'fill_tags', `正在添加 ${adapted.tags.length} 个抖音话题标签`);
      for (const tag of adapted.tags) {
        await page.typeTag(DESC_SELECTORS, tag, {
          suggestionSelectors: TAG_SUGGESTION_SELECTORS,
          commitKey: 'Enter',
        });
        await humanPause(page, 450, 950);
      }
      diagnostics.steps.push({ step: 'fill_tags', count: adapted.tags.length });
      await humanPause(page, 900, 1800);
    }

    // Optional cover upload (选择封面 -> 上传封面)
    if (adapted.coverPath) {
      const preCoverGuard = await checkDouyinGuard(page, { stage: 'pre_upload_cover', inFlow: true });
      if (preCoverGuard.blocked) {
        return buildGuardAbortResult(page, ctx, spec, preCoverGuard, diagnostics);
      }
      reportProgress(ctx, spec.id, 'upload_cover', '正在上传抖音自定义封面');
      const openCover = await clickWithTextFallback(page, COVER_TRIGGER_SELECTORS, ['选择封面', '设置封面', '编辑封面'], {
        timeoutMs: 3000,
      });
      if (openCover.clicked) {
        await humanPause(page, 500, 1000);
        await clickWithTextFallback(page, COVER_UPLOAD_TAB_SELECTORS, ['上传封面', '本地上传'], { timeoutMs: 2500 });
        await humanPause(page, 400, 800);
        await page.setFiles(COVER_INPUT_SELECTORS, [adapted.coverPath]);
        await humanPause(page, 1000, 1800);
        await clickWithTextFallback(page, COVER_CONFIRM_SELECTORS, ['完成', '确定'], { timeoutMs: 3000, exact: true });
        await humanPause(page, 900, 1800);
        diagnostics.steps.push({ step: 'upload_cover', applied: true });
      } else {
        diagnostics.steps.push({ step: 'upload_cover', applied: false, reason: 'cover_button_not_found' });
      }
    }

    // Optional AI-generated content declaration
    if (adapted.options.aiGenerated === true) {
      const aiClick = await clickWithTextFallback(page, ['[class*="ai-content"]'], ['内容由AI生成', 'AI生成', '自主声明'], {
        timeoutMs: 2500,
      });
      diagnostics.steps.push({ step: 'ai_generated_flag', applied: aiClick.clicked });
      await humanPause(page, 500, 1000);
    }

    // Optional visibility
    if (adapted.options.visibility && VISIBILITY_LABELS[adapted.options.visibility]) {
      const visClick = await clickWithTextFallback(page, [], VISIBILITY_LABELS[adapted.options.visibility], {
        timeoutMs: 2500,
      });
      diagnostics.steps.push({ step: 'visibility', target: adapted.options.visibility, applied: visClick.clicked });
      await humanPause(page, 500, 1000);
    }

    // Optional schedule (定时发布)
    if (adapted.scheduleAt) {
      const localSched = formatScheduleLocal(adapted.scheduleAt);
      if (localSched) {
        reportProgress(ctx, spec.id, 'schedule', `正在设置抖音定时发布：${localSched.dateTime}`);
        const schedClick = await clickWithTextFallback(page, ['input[value="2"]', '[class*="schedule"]'], ['定时发布'], {
          timeoutMs: 3000,
        });
        await humanPause(page, 500, 1000);
        if (schedClick.clicked) {
          await page.fillText(SCHEDULE_INPUT_SELECTORS, localSched.dateTime, { clear: true, humanJitter: false });
          await page.pressKey('Enter');
          diagnostics.steps.push({ step: 'schedule', dateTime: localSched.dateTime, applied: true });
          await humanPause(page, 600, 1200);
        } else {
          diagnostics.steps.push({ step: 'schedule', dateTime: localSched.dateTime, applied: false });
        }
      }
    }

    // Natural pre-submit pause (1.5–3.0s) & explicit guard check before Draft/Publish
    await humanPause(page, 1500, 3000);
    const preSubmitGuard = await checkDouyinGuard(page, { stage: 'pre_submit', inFlow: true });
    if (preSubmitGuard.blocked) {
      return buildGuardAbortResult(page, ctx, spec, preSubmitGuard, diagnostics);
    }

    // Draft mode
    if (mode === 'draft') {
      reportProgress(ctx, spec.id, 'save_draft', '正在保存抖音草稿');
      const draftClick = await clickWithTextFallback(page, DRAFT_BUTTON_SELECTORS, ['暂存离开', '存草稿', '保存草稿'], {
        timeoutMs: 3000,
      });
      if (draftClick.clicked) {
        await humanPause(page, 900, 1600);
        const postDraftGuard = await checkDouyinGuard(page, { stage: 'post_draft', inFlow: true });
        if (postDraftGuard.blocked) {
          return buildGuardAbortResult(page, ctx, spec, postDraftGuard, diagnostics);
        }
        diagnostics.draftMethod = 'button_click';
        diagnostics.draftSelector = draftClick.selector;
      } else {
        diagnostics.draftMethod = 'form_populated';
        diagnostics.keepTabOpen = true;
      }
      const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, 'draft_saved', diagnostics);
      return buildResult({
        platform: spec.id,
        status: 'draft_saved',
        url: await page.url(),
        screenshotPath,
        message: draftClick.clicked
          ? '抖音视频已保存至草稿箱'
          : '抖音视频与文案已填充完成（未点击草稿按钮，已保留当前标签页以便人工确认）',
        diagnostics,
      });
    }

    // Publish mode
    reportProgress(ctx, spec.id, 'publish', '正在提交发布抖音视频');
    const publishClick = await clickWithTextFallback(page, PUBLISH_BUTTON_SELECTORS, ['发布'], {
      timeoutMs: 5000,
      exact: true,
    });
    if (!publishClick.clicked) {
      diagnostics.keepTabOpen = true;
      const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, 'publish_btn_missing', diagnostics);
      return buildResult({
        platform: spec.id,
        status: 'failed',
        url: await page.url(),
        screenshotPath,
        message: '未找到抖音发布按钮，已保留表单内容与当前标签页',
        diagnostics,
      });
    }
    diagnostics.steps.push({ step: 'click_publish', selector: publishClick.selector });

    const publishTimeoutMs = ctx.options?.publishTimeoutMs ?? 20_000;
    const pollIntervalMs = ctx.options?.pollIntervalMs ?? 1200;
    const deadline = Date.now() + publishTimeoutMs;
    let publishedConfirmed = false;
    let finalUrl = (await page.url()) || '';

    let iter = 0;
    while (iter === 0 || Date.now() < deadline) {
      iter += 1;
      await page.sleep(jitteredInterval(pollIntervalMs));
      finalUrl = (await page.url()) || '';

      // Immediately detect Douyin's post-click SMS / captcha / slider / forced logout
      const postGuard = await checkDouyinGuard(page, { stage: 'post_submit', inFlow: true });
      if (postGuard.blocked) {
        return buildGuardAbortResult(page, ctx, spec, postGuard, diagnostics);
      }

      const afterText = await readPageText(page);
      if (
        /\/creator-micro\/content\/manage/i.test(finalUrl) ||
        /发布成功|作品已发布|定时发布成功/.test(afterText)
      ) {
        publishedConfirmed = true;
        break;
      }

      if (Date.now() >= deadline) break;
    }

    const screenshotPath = await captureScreenshot(
      page,
      ctx.screenshotDir,
      spec.id,
      publishedConfirmed ? (adapted.scheduleAt ? 'scheduled' : 'published') : 'publish_uncertain',
      diagnostics
    );

    if (!publishedConfirmed) {
      diagnostics.keepTabOpen = true;
      return buildResult({
        platform: spec.id,
        status: 'failed',
        url: finalUrl,
        screenshotPath,
        message: '已点击抖音发布按钮，但未检测到跳转到作品管理页或成功提示，请查看截图确认',
        diagnostics,
      });
    }

    return buildResult({
      platform: spec.id,
      status: adapted.scheduleAt ? 'scheduled' : 'published',
      url: finalUrl,
      screenshotPath,
      message: adapted.scheduleAt
        ? `抖音视频已设置定时发布（${adapted.scheduleAt}）`
        : '抖音视频发布成功',
      diagnostics,
    });
  } catch (err) {
    const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, 'error', diagnostics);
    return buildResult({
      platform: spec.id,
      status: 'failed',
      url: (await page.url().catch(() => null)) || null,
      screenshotPath,
      message: `抖音发布过程异常：${err instanceof Error ? err.message : String(err)}`,
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
