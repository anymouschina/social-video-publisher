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
  id: 'bilibili',
  name: 'B站 (Bilibili)',
  loginUrl: 'https://passport.bilibili.com/login',
  uploadUrl: 'https://member.bilibili.com/platform/upload/video/frame',
  limits: Object.freeze({
    titleMax: 80,
    descriptionMax: 2000,
    maxTags: 10,
    maxFileSizeMb: 16384,
    maxDurationSec: 36000,
    scheduleMinMinutes: 120,
    scheduleMaxDays: 15,
  }),
  capabilities: Object.freeze({
    draft: true,
    publish: true,
    schedule: true,
    cover: true,
    tags: true,
    originalFlag: true,
    aiGeneratedFlag: false,
    visibility: false,
  }),
});

const LOGIN_SELECTORS = [
  '.login-scan-wp',
  '.bili-mini-login-wrapper',
  'input[placeholder*="请输入账号"]',
  '.btn_primary.login-btn',
];

const UPLOAD_DROPZONE_SELECTORS = [
  '.bcc-upload-wrapper',
  '.upload-btn',
  '[class*="upload-drag"]',
  '[class*="upload-area"]',
];

const VIDEO_INPUT_SELECTORS = [
  '.bcc-upload-wrapper input[type="file"]',
  'input[type="file"][accept*="video"]',
  'input[type="file"][accept*=".mp4"]',
  'input[type="file"]',
];

const TITLE_SELECTORS = [
  'input[placeholder*="请输入稿件标题"]',
  'input[placeholder*="标题"]',
  '.video-title input.input-val',
  'input.input-val[maxlength="80"]',
];

const TAG_INPUT_SELECTORS = [
  'input[placeholder*="按回车键Enter创建标签"]',
  'input[placeholder*="创建标签"]',
  '.tag-input-wrp input.input-val',
  '.tag-input input',
];

const TAG_SUGGESTION_SELECTORS = [
  '.tag-search-item',
  '.tag-pre-wrp .tag-item',
];

const DESC_SELECTORS = [
  '.ql-editor',
  '.desc-text-wrp [contenteditable="true"]',
  'textarea[placeholder*="填写更全面的相关信息"]',
  'div[contenteditable="true"]',
];

const COVER_TRIGGER_SELECTORS = [
  '.cover-upload-mask',
  '.cover-wrp .cover-btn',
  '[class*="cover"] [class*="change"]',
];

const COVER_INPUT_SELECTORS = [
  '.cover-editor input[type="file"]',
  'input[type="file"][accept*="image"]',
];

const COVER_CONFIRM_SELECTORS = [
  '.cover-editor button.bcc-button--primary',
  '.bcc-dialog__footer button.bcc-button--primary',
];

const SCHEDULE_DATE_SELECTORS = [
  '.timing-wrp input[placeholder*="日期"]',
  '.date-picker-wrapper input',
];

const SCHEDULE_TIME_SELECTORS = [
  '.timing-wrp input[placeholder*="时间"]',
  '.time-picker-wrapper input',
];

const DRAFT_BUTTON_SELECTORS = [
  'span.submit-draft',
  'button[class*="draft"]',
  '.submit-container .submit-draft',
];

const PUBLISH_BUTTON_SELECTORS = [
  'span.submit-add',
  'button.submit-add',
  '.submit-container .submit-add',
];

const VERIFICATION_MODAL_SELECTORS = [
  '.geetest_panel',
  '.geetest_popup_box',
  '[class*="bili-verify"]',
  '[class*="captcha-dialog"]',
];

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
    warnings.push(`B站稿件标题上限为 ${spec.limits.titleMax} 字，已自动截断`);
  }
  if (!title) {
    warnings.push('B站投稿建议提供清晰标题（80 字以内）');
  }

  const description = clampText(rawDesc, spec.limits.descriptionMax);
  if (Array.from(rawDesc).length > spec.limits.descriptionMax) {
    warnings.push(`B站视频简介上限为 ${spec.limits.descriptionMax} 字，已自动截断`);
  }

  const tags = normalizeTags(rawTags, spec.limits.maxTags);
  const allUniqueTags = normalizeTags(rawTags, Infinity);
  if (allUniqueTags.length > spec.limits.maxTags) {
    warnings.push(`B站最多支持 ${spec.limits.maxTags} 个标签，已保留前 ${spec.limits.maxTags} 个`);
  }
  if (tags.length === 0) {
    warnings.push('B站投稿通常至少需要 1 个标签，建议补充 tags');
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
  if (options.aiGenerated === true) {
    warnings.push('B站适配器暂未启用 AI 生成声明开关，已忽略 options.aiGenerated');
  }
  if (options.visibility) {
    warnings.push('B站投稿页不支持自定义可见性范围，已忽略 options.visibility');
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

function isBilibiliLoginUrl(url) {
  return typeof url === 'string' && (/passport\.bilibili\.com\/login/i.test(url) || /\/login(?:[/?#]|$)/i.test(url));
}

function checkBilibiliGuard(page, { stage = 'flow', inFlow = false } = {}) {
  return checkPageGuardState(page, {
    platformName: spec.name,
    stage,
    inFlow,
    isLoginUrl: isBilibiliLoginUrl,
    loginSelectors: LOGIN_SELECTORS,
    verificationSelectors: VERIFICATION_MODAL_SELECTORS,
    extraLoginTextRegex: /扫码登录|密码登录|短信登录/,
  });
}

async function resolveUploadFrameUrl(page) {
  if (!page || typeof page.evaluate !== 'function') return null;
  try {
    const src = await page.evaluate(() => {
      if (typeof document === 'undefined') return null;
      const iframe =
        document.querySelector('iframe[name="videoUpload"]') ||
        document.querySelector('iframe[src*="upload/video"]') ||
        document.querySelector('iframe[src*="video/frame"]');
      if (!iframe) return null;
      const raw = iframe.getAttribute('src') || iframe.src || '';
      if (!raw) return null;
      if (raw.startsWith('//')) return `https:${raw}`;
      if (raw.startsWith('/')) return `https://member.bilibili.com${raw}`;
      return raw;
    });
    return typeof src === 'string' && src.startsWith('http') ? src : null;
  } catch {
    return null;
  }
}

export async function checkAuth(page) {
  await page.navigate(spec.uploadUrl, { timeoutMs: 30_000 });
  await humanDelay(600, 1100, page);

  const guard = await checkBilibiliGuard(page, { stage: 'check_auth', inFlow: false });
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
  const uploadDom = await safeQueryAny(page, [...VIDEO_INPUT_SELECTORS, 'iframe[name="videoUpload"]', '.bcc-upload-wrapper']);
  const loggedIn = currentUrl.includes('member.bilibili.com') && uploadDom.found;

  return {
    platform: spec.id,
    loggedIn,
    status: loggedIn ? 'logged_in' : 'needs_login',
    handle: null,
    accountName: null,
    url: currentUrl,
    message: loggedIn ? 'B站创作中心已登录' : '未能确认B站登录状态，请先登录创作中心',
    diagnostics: { matchedSelector: uploadDom.selector },
  };
}

export async function openLogin(page) {
  await page.navigate(spec.loginUrl, { timeoutMs: 30_000 });
  await humanDelay(500, 900, page);
  const currentUrl = (await page.url()) || spec.loginUrl;
  const alreadyLoggedIn = !isBilibiliLoginUrl(currentUrl) && currentUrl.includes('bilibili.com');
  return {
    platform: spec.id,
    status: alreadyLoggedIn ? 'already_logged_in' : 'login_opened',
    url: currentUrl,
    loginUrl: spec.loginUrl,
    message: alreadyLoggedIn
      ? 'B站当前已处于登录状态'
      : '已打开 B站 登录页，请在浏览器中完成扫码或账号登录',
    diagnostics: {},
  };
}

async function waitForBilibiliUploadComplete(page, ctx, diagnostics) {
  const timeoutMs = ctx.options?.uploadTimeoutMs ?? 180_000;
  const pollIntervalMs = ctx.options?.pollIntervalMs ?? 1800;
  const deadline = Date.now() + timeoutMs;

  let iteration = 0;
  while (iteration === 0 || Date.now() < deadline) {
    iteration += 1;

    // Run unified risk-control & forced-logout guard on EVERY poll iteration
    const guard = await checkBilibiliGuard(page, { stage: 'transcode', inFlow: true });
    if (guard.blocked) {
      diagnostics.uploadIterations = iteration;
      return { state: 'guard_blocked', guard };
    }

    const pageText = await readPageText(page);
    if (/上传失败|转码失败|格式不支持/.test(pageText)) {
      return { state: 'failed', reason: 'B站提示视频上传失败' };
    }

    const titleEl = await safeQueryAny(page, TITLE_SELECTORS);
    const uploadDone = /上传完成|100%|更换视频/.test(pageText);
    const stillUploading = /上传中|正在上传/.test(pageText) && !uploadDone;

    if (titleEl.found && !stillUploading) {
      diagnostics.uploadIterations = iteration;
      return { state: 'ready' };
    }

    if (Date.now() >= deadline) break;
    await page.sleep(jitteredInterval(pollIntervalMs));
  }

  return { state: 'timeout', reason: '等待B站视频上传完成超时' };
}

export async function publishVideo(page, ctx) {
  const diagnostics = { steps: [] };
  const validation = validate(ctx);
  if (!validation.valid) {
    return buildResult({
      platform: spec.id,
      status: 'failed',
      message: `B站参数校验失败：${validation.errors.join('；')}`,
      diagnostics: { errors: validation.errors, warnings: validation.warnings },
    });
  }

  const { adapted, warnings } = validation;
  const mode = adapted.mode;
  diagnostics.warnings = warnings;
  diagnostics.mode = mode;

  try {
    reportProgress(ctx, spec.id, 'navigate', '正在打开 B站 投稿页');
    await page.navigate(spec.uploadUrl, { timeoutMs: 30_000 });
    await humanDelay(600, 1200, page);

    const postNavGuard = await checkBilibiliGuard(page, { stage: 'post_navigate', inFlow: false });
    if (postNavGuard.blocked) {
      return buildGuardAbortResult(page, ctx, spec, postNavGuard, diagnostics);
    }

    let currentUrl = postNavGuard.url || (await page.url()) || '';

    // Handle Bilibili's iframe-hosted upload shell if file input isn't on top document
    const directInput = await safeQueryAny(page, VIDEO_INPUT_SELECTORS);
    if (!directInput.found) {
      const frameUrl = await resolveUploadFrameUrl(page);
      if (frameUrl && frameUrl !== currentUrl) {
        diagnostics.steps.push({ step: 'enter_upload_frame', frameUrl });
        await page.navigate(frameUrl, { timeoutMs: 30_000 });
        await humanDelay(500, 1000, page);
        const frameGuard = await checkBilibiliGuard(page, { stage: 'post_navigate_frame', inFlow: false });
        if (frameGuard.blocked) {
          return buildGuardAbortResult(page, ctx, spec, frameGuard, diagnostics);
        }
        currentUrl = frameGuard.url || frameUrl;
      }
    }

    // Natural page warmup (1.8–3.5s dwell + cursor drift + dropzone hover) before setFiles
    await warmupUploadPage(page, UPLOAD_DROPZONE_SELECTORS);

    reportProgress(ctx, spec.id, 'upload', '正在上传视频到 B站');
    const fileRes = await page.setFiles(VIDEO_INPUT_SELECTORS, [ctx.videoPath]);
    diagnostics.steps.push({ step: 'upload_file', selector: fileRes?.selector || null });
    await humanPause(page, 900, 1800);

    reportProgress(ctx, spec.id, 'transcode', '正在等待 B站 视频上传完成');
    const uploadState = await waitForBilibiliUploadComplete(page, ctx, diagnostics);
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
        message: uploadState.reason || 'B站视频上传未完成',
        diagnostics,
      });
    }

    // Pre-fill guard check + natural pause
    const preFillGuard = await checkBilibiliGuard(page, { stage: 'pre_fill', inFlow: true });
    if (preFillGuard.blocked) {
      return buildGuardAbortResult(page, ctx, spec, preFillGuard, diagnostics);
    }
    await humanPause(page, 900, 2000);

    // Fill title (<= 80 chars)
    if (adapted.title) {
      reportProgress(ctx, spec.id, 'fill_title', '正在填写 B站 稿件标题');
      await page.fillText(TITLE_SELECTORS, adapted.title, { clear: true, humanJitter: true });
      diagnostics.steps.push({ step: 'fill_title', length: Array.from(adapted.title).length });
      await humanPause(page, 900, 2000);
    }

    // Original vs Repost selection (自制 / 转载)
    if (adapted.options.original === false) {
      const repostClick = await clickWithTextFallback(page, [], ['转载'], { timeoutMs: 2500, exact: true });
      diagnostics.steps.push({ step: 'original_flag', original: false, applied: repostClick.clicked });
      await humanPause(page, 500, 1000);
    } else if (adapted.options.original === true) {
      const origClick = await clickWithTextFallback(page, [], ['自制'], { timeoutMs: 2500, exact: true });
      diagnostics.steps.push({ step: 'original_flag', original: true, applied: origClick.clicked });
      await humanPause(page, 500, 1000);
    }

    // Fill tags (<= 10)
    if (adapted.tags.length > 0) {
      const preTagsGuard = await checkBilibiliGuard(page, { stage: 'pre_fill_tags', inFlow: true });
      if (preTagsGuard.blocked) {
        return buildGuardAbortResult(page, ctx, spec, preTagsGuard, diagnostics);
      }
      reportProgress(ctx, spec.id, 'fill_tags', `正在添加 ${adapted.tags.length} 个 B站 标签`);
      for (const tag of adapted.tags) {
        await page.typeTag(TAG_INPUT_SELECTORS, tag, {
          suggestionSelectors: TAG_SUGGESTION_SELECTORS,
          commitKey: 'Enter',
        });
        await humanPause(page, 450, 950);
      }
      diagnostics.steps.push({ step: 'fill_tags', count: adapted.tags.length });
      await humanPause(page, 900, 1800);
    }

    // Fill description (<= 2000 chars)
    if (adapted.description) {
      const preDescGuard = await checkBilibiliGuard(page, { stage: 'pre_fill_description', inFlow: true });
      if (preDescGuard.blocked) {
        return buildGuardAbortResult(page, ctx, spec, preDescGuard, diagnostics);
      }
      reportProgress(ctx, spec.id, 'fill_description', '正在填写 B站 视频简介');
      await page.fillText(DESC_SELECTORS, adapted.description, { clear: true, humanJitter: true });
      diagnostics.steps.push({ step: 'fill_description', length: Array.from(adapted.description).length });
      await humanPause(page, 1100, 2400);
    }

    // Optional cover upload
    if (adapted.coverPath) {
      const preCoverGuard = await checkBilibiliGuard(page, { stage: 'pre_upload_cover', inFlow: true });
      if (preCoverGuard.blocked) {
        return buildGuardAbortResult(page, ctx, spec, preCoverGuard, diagnostics);
      }
      reportProgress(ctx, spec.id, 'upload_cover', '正在上传 B站 稿件封面');
      const openCover = await clickWithTextFallback(page, COVER_TRIGGER_SELECTORS, ['更改封面', '上传封面', '封面设置'], {
        timeoutMs: 3000,
      });
      if (openCover.clicked) {
        await humanPause(page, 500, 1000);
        await page.setFiles(COVER_INPUT_SELECTORS, [adapted.coverPath]);
        await humanPause(page, 1000, 1800);
        await clickWithTextFallback(page, COVER_CONFIRM_SELECTORS, ['完成', '确定'], { timeoutMs: 3000, exact: true });
        await humanPause(page, 900, 1800);
        diagnostics.steps.push({ step: 'upload_cover', applied: true });
      } else {
        diagnostics.steps.push({ step: 'upload_cover', applied: false, reason: 'cover_button_not_found' });
      }
    }

    // Optional schedule (定时发布)
    if (adapted.scheduleAt) {
      const localSched = formatScheduleLocal(adapted.scheduleAt);
      if (localSched) {
        reportProgress(ctx, spec.id, 'schedule', `正在设置 B站 定时发布：${localSched.dateTime}`);
        const schedToggle = await clickWithTextFallback(page, ['.timing-wrp .bcc-switch'], ['定时发布'], {
          timeoutMs: 3000,
        });
        await humanPause(page, 500, 1000);
        if (schedToggle.clicked) {
          const dateField = await safeQueryAny(page, SCHEDULE_DATE_SELECTORS);
          if (dateField.found) {
            await page.fillText(SCHEDULE_DATE_SELECTORS, localSched.date, { clear: true, humanJitter: false });
          }
          const timeField = await safeQueryAny(page, SCHEDULE_TIME_SELECTORS);
          if (timeField.found) {
            await page.fillText(SCHEDULE_TIME_SELECTORS, localSched.time, { clear: true, humanJitter: false });
          }
          diagnostics.steps.push({ step: 'schedule', dateTime: localSched.dateTime, applied: true });
          await humanPause(page, 600, 1200);
        } else {
          diagnostics.steps.push({ step: 'schedule', dateTime: localSched.dateTime, applied: false });
        }
      }
    }

    // Natural pre-submit pause (1.5–3.0s) & unified guard check
    await humanPause(page, 1500, 3000);
    const preSubmitGuard = await checkBilibiliGuard(page, { stage: 'pre_submit', inFlow: true });
    if (preSubmitGuard.blocked) {
      return buildGuardAbortResult(page, ctx, spec, preSubmitGuard, diagnostics);
    }

    // Draft mode (存草稿)
    if (mode === 'draft') {
      reportProgress(ctx, spec.id, 'save_draft', '正在保存 B站 草稿');
      const draftClick = await clickWithTextFallback(page, DRAFT_BUTTON_SELECTORS, ['存草稿', '保存草稿'], {
        timeoutMs: 3000,
      });
      if (draftClick.clicked) {
        await humanPause(page, 900, 1600);
        const postDraftGuard = await checkBilibiliGuard(page, { stage: 'post_draft', inFlow: true });
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
          ? 'B站视频稿件已保存至草稿箱'
          : 'B站投稿信息已填充完成（未找到存草稿按钮，已保留当前标签页以防表单丢失）',
        diagnostics,
      });
    }

    // Publish mode (立即投稿)
    reportProgress(ctx, spec.id, 'publish', '正在提交 B站 稿件');
    const publishClick = await clickWithTextFallback(page, PUBLISH_BUTTON_SELECTORS, ['立即投稿', '投稿'], {
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
        message: '未找到 B站「立即投稿」按钮，已保留当前稿件内容与标签页',
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

      const postGuard = await checkBilibiliGuard(page, { stage: 'post_submit', inFlow: true });
      if (postGuard.blocked) {
        return buildGuardAbortResult(page, ctx, spec, postGuard, diagnostics);
      }

      const afterText = await readPageText(page);
      if (
        /稿件投递成功|投稿成功|定时发布成功|已进入审核/.test(afterText) ||
        /\/upload\/video\/result|\/article-up|\/platform\/upload-manager/i.test(finalUrl)
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
        message: '已点击 B站「立即投稿」，但未检测到投递成功提示，请查看截图确认',
        diagnostics,
      });
    }

    return buildResult({
      platform: spec.id,
      status: adapted.scheduleAt ? 'scheduled' : 'published',
      url: finalUrl,
      screenshotPath,
      message: adapted.scheduleAt
        ? `B站稿件已设置定时发布（${adapted.scheduleAt}）`
        : 'B站稿件投递成功',
      diagnostics,
    });
  } catch (err) {
    const screenshotPath = await captureScreenshot(page, ctx.screenshotDir, spec.id, 'error', diagnostics);
    return buildResult({
      platform: spec.id,
      status: 'failed',
      url: (await page.url().catch(() => null)) || null,
      screenshotPath,
      message: `B站投稿过程异常：${err instanceof Error ? err.message : String(err)}`,
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
