import {
  buildResult,
  captureScreenshot,
  clampText,
  clickWithTextFallback,
  detectVerificationPrompt,
  formatScheduleLocal,
  humanDelay,
  normalizeTags,
  readPageText,
  reportProgress,
  safeQueryAny,
  validateCommonMedia,
  validateScheduleWindow,
} from './base.mjs';

export const spec = Object.freeze({
  id: 'xiaohongshu',
  name: '小红书',
  loginUrl: 'https://creator.xiaohongshu.com/login',
  uploadUrl: 'https://creator.xiaohongshu.com/publish/publish?from=tab_switch&target=video',
  limits: Object.freeze({
    titleMax: 20,
    descriptionMax: 1000,
    maxTags: 10,
    maxFileSizeMb: 20480,
    maxDurationSec: 900,
    scheduleMinMinutes: 60,
    scheduleMaxDays: 14,
  }),
  capabilities: Object.freeze({
    draft: true,
    publish: true,
    schedule: true,
    cover: true,
    tags: true,
    originalFlag: true,
    aiGeneratedFlag: true,
    visibility: true,
  }),
});

const LOGIN_SELECTORS = [
  'input[placeholder*="手机号"]',
  '.login-container',
  '.login-box-container',
  '[class*="login-btn"]',
];

const VIDEO_INPUT_SELECTORS = [
  'input.upload-input',
  'input[type="file"][accept*="video"]',
  'input[type="file"][accept*=".mp4"]',
  '.upload-wrapper input[type="file"]',
  'input[type="file"]',
];

const TITLE_SELECTORS = [
  'input[placeholder*="填写标题"]',
  'input[placeholder*="标题"]',
  '.title-input input',
  'input.d-text',
  'input[maxlength="20"]',
];

const DESC_SELECTORS = [
  '.ql-editor',
  '[contenteditable="true"][data-placeholder*="正文"]',
  '[contenteditable="true"][data-placeholder*="描述"]',
  '.tiptap.ProseMirror',
  '#post-textarea',
  'div[contenteditable="true"]',
];

const TAG_SUGGESTION_SELECTORS = [
  '#creator-editor-topic-container .item',
  '.topic-list .topic-item',
  '.publish-topic-item',
  '.ql-mention-list-item',
];

const COVER_TRIGGER_SELECTORS = [
  '.cover-edit-btn',
  '[class*="cover"] button',
  '.edit-cover-btn',
];

const COVER_INPUT_SELECTORS = [
  '.cover-upload input[type="file"]',
  'input[type="file"][accept*="image"]',
  '.upload-cover input[type="file"]',
];

const COVER_CONFIRM_SELECTORS = [
  '.cover-modal button.d-button--primary',
  '.d-modal-footer button.d-button--primary',
];

const SCHEDULE_INPUT_SELECTORS = [
  'input[placeholder*="选择日期"]',
  'input[placeholder*="定时发布"]',
  '.date-picker-container input',
  '.d-datepicker input',
];

const DRAFT_BUTTON_SELECTORS = [
  'button.draft-btn',
  'button[class*="draft"]',
  '.publish-page-publish-btn button.cancel',
];

const PUBLISH_BUTTON_SELECTORS = [
  'button.publishBtn',
  '.publish-page-publish-btn button.d-button--primary',
  '.submit button.css-k3hpu2',
  'button[class*="publishBtn"]',
];

const VERIFICATION_MODAL_SELECTORS = [
  '.red-captcha-modal',
  '[class*="captcha-modal"]',
  '[class*="verify-modal"]',
  '.sms-verify-dialog',
];

const UPLOAD_READY_SELECTORS = [
  '.reupload-btn',
  '[class*="reupload"]',
  '.stage-success',
  'video',
];

const VISIBILITY_LABELS = Object.freeze({
  public: ['公开可见', '公开'],
  private: ['仅自己可见', '私密'],
  friends: ['仅互关好友可见', '好友可见'],
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
    warnings.push(`小红书标题上限为 ${spec.limits.titleMax} 字，已自动截断为：${title}`);
  }
  if (!title) {
    warnings.push('小红书未填写标题，建议补充 20 字以内的高点击标题');
  }

  const description = clampText(rawDesc, spec.limits.descriptionMax);
  if (Array.from(rawDesc).length > spec.limits.descriptionMax) {
    warnings.push(`小红书正文上限为 ${spec.limits.descriptionMax} 字，已自动截断`);
  }

  const tags = normalizeTags(rawTags, spec.limits.maxTags);
  const allUniqueTags = normalizeTags(rawTags, Infinity);
  if (allUniqueTags.length > spec.limits.maxTags) {
    warnings.push(`小红书最多支持 ${spec.limits.maxTags} 个话题标签，已保留前 ${spec.limits.maxTags} 个`);
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
  if (options.visibility && !VISIBILITY_LABELS[options.visibility]) {
    errors.push(`小红书不支持可见性选项 visibility="${options.visibility}"，可选值：public / private / friends`);
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

function isLoginUrl(url) {
  return typeof url === 'string' && (/\/login(?:[/?#]|$)/i.test(url) || url.includes('passport.xiaohongshu.com'));
}

export async function checkAuth(page) {
  await page.navigate(spec.uploadUrl, { timeoutMs: 30_000 });
  await humanDelay(600, 1100, page);

  const currentUrl = (await page.url()) || '';
  const pageText = await readPageText(page);

  const verify = detectVerificationPrompt(pageText);
  if (verify.detected) {
    return {
      platform: spec.id,
      loggedIn: false,
      status: 'needs_verification',
      handle: null,
      accountName: null,
      url: currentUrl,
      message: `小红书创作者中心触发安全验证（${verify.kind}），请先在浏览器完成验证`,
      diagnostics: { verification: verify },
    };
  }

  const loginDom = await safeQueryAny(page, LOGIN_SELECTORS);
  if (isLoginUrl(currentUrl) || (loginDom.found && loginDom.visible) || /短信登录|扫码登录/.test(pageText)) {
    return {
      platform: spec.id,
      loggedIn: false,
      status: 'needs_login',
      handle: null,
      accountName: null,
      url: currentUrl,
      message: '小红书创作者中心未登录，请先调用 open_login 扫码登录',
      diagnostics: { loginSelector: loginDom.selector },
    };
  }

  const uploadDom = await safeQueryAny(page, [...VIDEO_INPUT_SELECTORS, ...TITLE_SELECTORS]);
  const accountName = await extractAccountName(page);
  const loggedIn = currentUrl.includes('creator.xiaohongshu.com') && (uploadDom.found || Boolean(accountName));

  return {
    platform: spec.id,
    loggedIn,
    status: loggedIn ? 'logged_in' : 'needs_login',
    handle: accountName,
    accountName,
    url: currentUrl,
    message: loggedIn
      ? `小红书已登录${accountName ? `（${accountName}）` : ''}`
      : '未能确认小红书登录状态，请重新登录创作者中心',
    diagnostics: { matchedSelector: uploadDom.selector },
  };
}

export async function openLogin(page) {
  await page.navigate(spec.loginUrl, { timeoutMs: 30_000 });
  await humanDelay(500, 900, page);
  const currentUrl = (await page.url()) || spec.loginUrl;
  const alreadyLoggedIn = currentUrl.includes('creator.xiaohongshu.com') && !isLoginUrl(currentUrl);
  return {
    platform: spec.id,
    status: alreadyLoggedIn ? 'already_logged_in' : 'login_opened',
    url: currentUrl,
    loginUrl: spec.loginUrl,
    message: alreadyLoggedIn
      ? '小红书创作者中心当前已处于登录状态'
      : '已打开小红书创作者登录页，请在浏览器中完成扫码或短信登录',
    diagnostics: {},
  };
}

async function extractAccountName(page) {
  if (!page || typeof page.evaluate !== 'function') return null;
  try {
    const name = await page.evaluate(() => {
      if (typeof document === 'undefined') return null;
      const selectors = [
        '.user-info .name',
        '.account-name',
        '.creator-name',
        '[class*="user-name"]',
        '[class*="nickname"]',
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

async function waitForUploadComplete(page, ctx, diagnostics) {
  const timeoutMs = ctx.options?.uploadTimeoutMs ?? 180_000;
  const pollIntervalMs = ctx.options?.pollIntervalMs ?? 1500;
  const deadline = Date.now() + timeoutMs;

  let iteration = 0;
  while (iteration === 0 || Date.now() < deadline) {
    iteration += 1;
    const pageText = await readPageText(page);
    const verify = detectVerificationPrompt(pageText);
    const verifyModal = await safeQueryAny(page, VERIFICATION_MODAL_SELECTORS);
    if (verify.detected || (verifyModal.found && verifyModal.visible)) {
      return { state: 'needs_verification', verify };
    }

    if (/上传失败|转码失败|格式不支持/.test(pageText)) {
      return { state: 'failed', reason: '小红书提示视频上传或转码失败' };
    }

    const titleEl = await safeQueryAny(page, TITLE_SELECTORS);
    const readyEl = await safeQueryAny(page, UPLOAD_READY_SELECTORS);
    const publishBtn = await safeQueryAny(page, PUBLISH_BUTTON_SELECTORS);
    const stillUploading = /上传中|正在上传|转码中|解析中/.test(pageText) && !/上传成功|重新上传|替换视频/.test(pageText);

    if (titleEl.found && !stillUploading && (readyEl.found || /上传成功|重新上传|替换视频/.test(pageText) || (publishBtn.found && !publishBtn.disabled))) {
      diagnostics.uploadIterations = iteration;
      return { state: 'ready' };
    }

    if (Date.now() >= deadline) break;
    await page.sleep(pollIntervalMs);
  }

  return { state: 'timeout', reason: '等待小红书视频上传与转码完成超时' };
}

export async function publishVideo(page, ctx) {
  const diagnostics = { steps: [] };
  const validation = validate(ctx);
  if (!validation.valid) {
    return buildResult({
      platform: spec.id,
      status: 'failed',
      message: `小红书参数校验失败：${validation.errors.join('；')}`,
      diagnostics: { errors: validation.errors, warnings: validation.warnings },
    });
  }

  const { adapted, warnings } = validation;
  const mode = adapted.mode;
  diagnostics.warnings = warnings;
  diagnostics.mode = mode;

  try {
    reportProgress(ctx, spec.id, 'navigate', '正在打开小红书视频发布页');
    await page.navigate(spec.uploadUrl, { timeoutMs: 30_000 });
    await humanDelay(600, 1200, page);

    const currentUrl = (await page.url()) || '';
    const initialText = await readPageText(page);
    const initialVerify = detectVerificationPrompt(initialText);
    if (initialVerify.detected) {
      const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, 'verification', diagnostics);
      return buildResult({
        platform: spec.id,
        status: 'needs_verification',
        url: currentUrl,
        screenshotPath,
        message: `小红书触发安全验证（${initialVerify.kind}），请手动完成后重试`,
        diagnostics: { ...diagnostics, verification: initialVerify },
      });
    }

    const loginDom = await safeQueryAny(page, LOGIN_SELECTORS);
    if (isLoginUrl(currentUrl) || (loginDom.found && loginDom.visible) || /短信登录|扫码登录/.test(initialText)) {
      const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, 'needs_login', diagnostics);
      return buildResult({
        platform: spec.id,
        status: 'needs_login',
        url: currentUrl,
        screenshotPath,
        message: '小红书创作者中心未登录，请先登录后重试',
        diagnostics,
      });
    }

    // Ensure "上传视频" tab is active if file input is not immediately present
    const initialInput = await safeQueryAny(page, VIDEO_INPUT_SELECTORS);
    if (!initialInput.found) {
      await clickWithTextFallback(page, [], ['上传视频'], { timeoutMs: 3000, exact: true });
      await humanDelay(300, 700, page);
    }

    reportProgress(ctx, spec.id, 'upload', '正在上传视频到小红书');
    const fileRes = await page.setFiles(VIDEO_INPUT_SELECTORS, [ctx.videoPath]);
    diagnostics.steps.push({ step: 'upload_file', selector: fileRes?.selector || null });
    await humanDelay(500, 1000, page);

    reportProgress(ctx, spec.id, 'transcode', '正在等待小红书视频上传与转码完成');
    const uploadState = await waitForUploadComplete(page, ctx, diagnostics);
    if (uploadState.state === 'needs_verification') {
      const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, 'verification', diagnostics);
      return buildResult({
        platform: spec.id,
        status: 'needs_verification',
        url: await page.url(),
        screenshotPath,
        message: '小红书在上传阶段弹出安全验证，请在浏览器完成验证',
        diagnostics: { ...diagnostics, verification: uploadState.verify },
      });
    }
    if (uploadState.state !== 'ready') {
      const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, 'upload_failed', diagnostics);
      return buildResult({
        platform: spec.id,
        status: 'failed',
        url: await page.url(),
        screenshotPath,
        message: uploadState.reason || '小红书视频上传未完成',
        diagnostics,
      });
    }

    // Fill title
    if (adapted.title) {
      reportProgress(ctx, spec.id, 'fill_title', '正在填写小红书标题');
      await page.fillText(TITLE_SELECTORS, adapted.title, { clear: true, humanJitter: true });
      diagnostics.steps.push({ step: 'fill_title', length: Array.from(adapted.title).length });
      await humanDelay(250, 600, page);
    }

    // Fill description
    if (adapted.description) {
      reportProgress(ctx, spec.id, 'fill_description', '正在填写小红书正文');
      await page.fillText(DESC_SELECTORS, adapted.description, { clear: true, humanJitter: true });
      diagnostics.steps.push({ step: 'fill_description', length: Array.from(adapted.description).length });
      await humanDelay(250, 600, page);
    }

    // Add #tags via topic selection
    if (adapted.tags.length > 0) {
      reportProgress(ctx, spec.id, 'fill_tags', `正在添加 ${adapted.tags.length} 个小红书话题标签`);
      for (const tag of adapted.tags) {
        await page.typeTag(DESC_SELECTORS, tag, {
          suggestionSelectors: TAG_SUGGESTION_SELECTORS,
          commitKey: 'Enter',
        });
        await humanDelay(250, 550, page);
      }
      diagnostics.steps.push({ step: 'fill_tags', count: adapted.tags.length });
    }

    // Optional cover upload
    if (adapted.coverPath) {
      reportProgress(ctx, spec.id, 'upload_cover', '正在设置小红书视频封面');
      const coverTrigger = await clickWithTextFallback(page, COVER_TRIGGER_SELECTORS, ['修改封面', '设置封面', '更换封面'], {
        timeoutMs: 3000,
      });
      if (coverTrigger.clicked) {
        await humanDelay(300, 600, page);
        await clickWithTextFallback(page, [], ['上传封面', '本地上传'], { timeoutMs: 2500 });
        await humanDelay(200, 450, page);
        await page.setFiles(COVER_INPUT_SELECTORS, [adapted.coverPath]);
        await humanDelay(800, 1400, page);
        await clickWithTextFallback(page, COVER_CONFIRM_SELECTORS, ['确定', '完成'], { timeoutMs: 3000, exact: true });
        await humanDelay(400, 800, page);
        diagnostics.steps.push({ step: 'upload_cover', applied: true });
      } else {
        diagnostics.steps.push({ step: 'upload_cover', applied: false, reason: 'cover_button_not_found' });
      }
    }

    // Optional original flag
    if (adapted.options.original === true) {
      const origRes = await clickWithTextFallback(page, ['.original-switch', '[class*="original"] input[type="checkbox"]'], ['声明原创', '原创声明'], {
        timeoutMs: 2500,
      });
      diagnostics.steps.push({ step: 'original_flag', applied: origRes.clicked });
      await humanDelay(200, 450, page);
    }

    // Optional AI-generated disclosure
    if (adapted.options.aiGenerated === true) {
      const aiRes = await clickWithTextFallback(page, ['[class*="ai-declare"]'], ['内容由AI生成', 'AI生成', '自主声明'], {
        timeoutMs: 2500,
      });
      diagnostics.steps.push({ step: 'ai_generated_flag', applied: aiRes.clicked });
      await humanDelay(200, 450, page);
    }

    // Optional visibility
    if (adapted.options.visibility && VISIBILITY_LABELS[adapted.options.visibility]) {
      const visRes = await clickWithTextFallback(page, [], VISIBILITY_LABELS[adapted.options.visibility], {
        timeoutMs: 2500,
      });
      diagnostics.steps.push({ step: 'visibility', target: adapted.options.visibility, applied: visRes.clicked });
      await humanDelay(200, 450, page);
    }

    // Optional schedule
    if (adapted.scheduleAt) {
      const localSched = formatScheduleLocal(adapted.scheduleAt);
      if (localSched) {
        reportProgress(ctx, spec.id, 'schedule', `正在设置小红书定时发布：${localSched.dateTime}`);
        const schedToggle = await clickWithTextFallback(page, ['.schedule-switch', '[class*="post-time"]'], ['定时发布'], {
          timeoutMs: 3000,
        });
        await humanDelay(300, 600, page);
        if (schedToggle.clicked) {
          await page.fillText(SCHEDULE_INPUT_SELECTORS, localSched.dateTime, { clear: true, humanJitter: false });
          await page.pressKey('Enter');
          diagnostics.steps.push({ step: 'schedule', dateTime: localSched.dateTime, applied: true });
          await humanDelay(300, 600, page);
        } else {
          diagnostics.steps.push({ step: 'schedule', dateTime: localSched.dateTime, applied: false });
        }
      }
    }

    // Pre-submit verification check
    const preSubmitText = await readPageText(page);
    const preSubmitVerify = detectVerificationPrompt(preSubmitText);
    const preSubmitModal = await safeQueryAny(page, VERIFICATION_MODAL_SELECTORS);
    if (preSubmitVerify.detected || (preSubmitModal.found && preSubmitModal.visible)) {
      const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, 'verification', diagnostics);
      return buildResult({
        platform: spec.id,
        status: 'needs_verification',
        url: await page.url(),
        screenshotPath,
        message: '小红书弹出安全验证弹窗，请在浏览器完成验证后继续',
        diagnostics: { ...diagnostics, verification: preSubmitVerify },
      });
    }

    // Draft vs Publish
    if (mode === 'draft') {
      reportProgress(ctx, spec.id, 'save_draft', '正在保存小红书草稿');
      const draftClick = await clickWithTextFallback(page, DRAFT_BUTTON_SELECTORS, ['暂存离开', '存草稿', '保存草稿'], {
        timeoutMs: 3000,
      });
      if (draftClick.clicked) {
        await humanDelay(800, 1400, page);
        diagnostics.draftMethod = 'button_click';
        diagnostics.draftSelector = draftClick.selector;
      } else {
        diagnostics.draftMethod = 'form_populated';
      }
      const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, 'draft_saved', diagnostics);
      return buildResult({
        platform: spec.id,
        status: 'draft_saved',
        url: await page.url(),
        screenshotPath,
        message: draftClick.clicked
          ? '小红书视频已保存至草稿箱'
          : '小红书视频与文案已填充完成（未找到暂存按钮，页面保持待审核发布状态）',
        diagnostics,
      });
    }

    // mode === 'publish'
    reportProgress(ctx, spec.id, 'publish', '正在提交发布小红书视频');
    const publishClick = await clickWithTextFallback(
      page,
      PUBLISH_BUTTON_SELECTORS,
      adapted.scheduleAt ? ['定时发布', '发布'] : ['发布', '发布笔记'],
      { timeoutMs: 5000, exact: true }
    );
    if (!publishClick.clicked) {
      const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, 'publish_btn_missing', diagnostics);
      return buildResult({
        platform: spec.id,
        status: 'failed',
        url: await page.url(),
        screenshotPath,
        message: '未找到小红书发布按钮，已保留当前页面内容',
        diagnostics,
      });
    }

    diagnostics.steps.push({ step: 'click_publish', selector: publishClick.selector });

    const publishTimeoutMs = ctx.options?.publishTimeoutMs ?? 20_000;
    const pollIntervalMs = ctx.options?.pollIntervalMs ?? 1000;
    const deadline = Date.now() + publishTimeoutMs;
    let publishedConfirmed = false;
    let finalUrl = (await page.url()) || '';

    let iter = 0;
    while (iter === 0 || Date.now() < deadline) {
      iter += 1;
      await page.sleep(pollIntervalMs);
      finalUrl = (await page.url()) || '';
      const afterText = await readPageText(page);
      const afterVerify = detectVerificationPrompt(afterText);
      const afterModal = await safeQueryAny(page, VERIFICATION_MODAL_SELECTORS);

      if (afterVerify.detected || (afterModal.found && afterModal.visible)) {
        const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, 'verification', diagnostics);
        return buildResult({
          platform: spec.id,
          status: 'needs_verification',
          url: finalUrl,
          screenshotPath,
          message: `点击发布后小红书要求安全验证（${afterVerify.kind || 'modal'}），请在浏览器中完成验证`,
          diagnostics: { ...diagnostics, verification: afterVerify },
        });
      }

      if (
        /\/publish\/success|\/new\/note-manager|\/creator\/post/i.test(finalUrl) ||
        /发布成功|定时发布成功|笔记已发布|已进入审核/.test(afterText)
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
      return buildResult({
        platform: spec.id,
        status: 'failed',
        url: finalUrl,
        screenshotPath,
        message: '已点击小红书发布按钮，但在预期时间内未检测到发布成功跳转或提示，请查看截图确认',
        diagnostics,
      });
    }

    return buildResult({
      platform: spec.id,
      status: adapted.scheduleAt ? 'scheduled' : 'published',
      url: finalUrl,
      screenshotPath,
      message: adapted.scheduleAt
        ? `小红书视频已设置定时发布（${adapted.scheduleAt}）`
        : '小红书视频发布成功',
      diagnostics,
    });
  } catch (err) {
    const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, 'error', diagnostics);
    return buildResult({
      platform: spec.id,
      status: 'failed',
      url: (await page.url().catch(() => null)) || null,
      screenshotPath,
      message: `小红书发布过程异常：${err instanceof Error ? err.message : String(err)}`,
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
