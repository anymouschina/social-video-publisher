import {
  BrowserSession,
  discoverCdpCandidates,
  findBrowserBinary,
  probeCdpEndpoint,
} from './cdp.mjs';
import {
  BskSession,
  probeBskAvailable,
} from './bsk.mjs';
import { redactSensitiveText } from './constants.mjs';

const VALID_BACKENDS = Object.freeze(new Set(['auto', 'bsk', 'cdp']));

function resolveRequestedBackend(options = {}) {
  const env = options.env || process.env;
  const raw = options.backend ?? env.SOCIAL_PUB_TRANSPORT ?? env.SOCIAL_PUB_BACKEND ?? 'auto';
  const normalized = String(raw || 'auto').trim().toLowerCase();
  if (!VALID_BACKENDS.has(normalized)) {
    throw new Error(`不支持的浏览器传输后端：${raw}（仅支持 auto / bsk / cdp）`);
  }
  return normalized;
}

/**
 * Probes available browser transports (`bsk` real logged-in browser vs local CDP)
 * without opening a new session or launching Chrome.
 *
 * @param {{
 *   backend?: 'auto' | 'bsk' | 'cdp',
 *   cdpUrl?: string,
 *   profileDir?: string,
 *   browserId?: string,
 *   bskBin?: string,
 *   env?: NodeJS.ProcessEnv,
 *   execFileImpl?: Function,
 *   bskProbeImpl?: Function,
 * }} [options]
 */
export async function probeBrowserTransport(options = {}) {
  const env = options.env || process.env;
  const requestedBackend = resolveRequestedBackend(options);
  const explicitCdpUrl = String(options.cdpUrl || '').trim();

  const bskProbeFn = options.bskProbeImpl || probeBskAvailable;
  const bsk = await bskProbeFn({
    browserId: options.browserId || '',
    env,
    execFileImpl: options.execFileImpl,
    bskBin: options.bskBin || '',
  });

  const candidates = discoverCdpCandidates({
    cdpUrl: explicitCdpUrl,
    profileDir: options.profileDir || '',
    env,
  });

  let activeCdp = null;
  for (const candidate of candidates) {
    const alive = await probeCdpEndpoint(candidate.cdpUrl);
    if (alive) {
      activeCdp = {
        cdpUrl: alive.cdpUrl,
        source: candidate.source,
        browser: alive.browser,
      };
      break;
    }
  }

  let selectedBackend;
  if (explicitCdpUrl || requestedBackend === 'cdp') {
    selectedBackend = 'cdp';
  } else if (requestedBackend === 'bsk') {
    selectedBackend = 'bsk';
  } else {
    selectedBackend = bsk?.available ? 'bsk' : 'cdp';
  }

  return {
    requestedBackend,
    selectedBackend,
    bsk,
    cdp: {
      explicitCdpUrl: explicitCdpUrl || null,
      activeEndpoint: activeCdp,
      chromeBinaryFound: Boolean(findBrowserBinary(process.platform, env)),
    },
  };
}

/**
 * Unified browser session factory supporting:
 * - `backend: 'auto'` (default): prefers `bsk` real logged-in browser; falls back cleanly to CDP if unavailable
 * - `backend: 'bsk'`: requires `bsk` and throws explicitly if unavailable (no silent downgrade)
 * - `backend: 'cdp'` or explicit `cdpUrl`: connects directly via CDP `BrowserSession.connect`
 *
 * Always attaches `session.transportMeta`.
 *
 * @param {{
 *   backend?: 'auto' | 'bsk' | 'cdp',
 *   cdpUrl?: string,
 *   profileDir?: string,
 *   launchIfMissing?: boolean,
 *   browserId?: string,
 *   scope?: string,
 *   focus?: boolean,
 *   width?: number,
 *   height?: number,
 *   bskBin?: string,
 *   fastMode?: boolean,
 *   rng?: () => number,
 *   env?: NodeJS.ProcessEnv,
 *   execFileImpl?: Function,
 *   bskProbeImpl?: Function,
 *   bskConnectImpl?: Function,
 *   cdpConnectImpl?: Function,
 * }} [options]
 */
export async function openBrowserSession(options = {}) {
  const env = options.env || process.env;
  const backend = resolveRequestedBackend(options);
  const explicitCdpUrl = String(options.cdpUrl || '').trim();

  const bskProbeFn = options.bskProbeImpl || probeBskAvailable;
  const bskConnectFn = options.bskConnectImpl || ((opts) => BskSession.connect(opts));
  const cdpConnectFn = options.cdpConnectImpl || ((opts) => BrowserSession.connect(opts));

  const connectCdp = async (fallbackReason = null) => {
    const session = await cdpConnectFn({
      cdpUrl: explicitCdpUrl,
      profileDir: options.profileDir || '',
      env,
      launchIfMissing: options.launchIfMissing ?? true,
    });
    session.transportMeta = {
      backend: 'cdp',
      source: session.source || 'cdp',
      cdpUrl: session.cdpUrl || '',
      profileDir: session.profileDir || '',
      ...(fallbackReason ? { fallbackReason } : {}),
    };
    return session;
  };

  const attachBskMeta = (session) => {
    session.transportMeta = {
      backend: 'bsk',
      source: 'bsk',
      browserInstanceId: session.browserInstanceId || '',
      browserLabel: session.browserLabel || '',
      sessionId: session.sessionId || '',
    };
    return session;
  };

  // Explicit cdpUrl or explicit backend === 'cdp' always uses CDP.
  if (explicitCdpUrl || backend === 'cdp') {
    return connectCdp();
  }

  // Explicit backend === 'bsk' MUST NOT silently downgrade to CDP.
  if (backend === 'bsk') {
    const session = await bskConnectFn({
      browserId: options.browserId || '',
      scope: options.scope || 'social-video-publisher',
      focus: Boolean(options.focus),
      width: options.width,
      height: options.height,
      env,
      execFileImpl: options.execFileImpl,
      fastMode: options.fastMode,
      rng: options.rng,
      bskBin: options.bskBin || '',
    });
    return attachBskMeta(session);
  }

  // Default backend === 'auto': probe BSK first, fall back cleanly to CDP if unavailable or connect fails.
  const probe = await bskProbeFn({
    browserId: options.browserId || '',
    env,
    execFileImpl: options.execFileImpl,
    bskBin: options.bskBin || '',
  });

  if (probe && probe.available) {
    try {
      const session = await bskConnectFn({
        browserId: options.browserId || probe.browser?.instance_id || '',
        scope: options.scope || 'social-video-publisher',
        focus: Boolean(options.focus),
        width: options.width,
        height: options.height,
        env,
        execFileImpl: options.execFileImpl,
        fastMode: options.fastMode,
        rng: options.rng,
        bskBin: options.bskBin || probe.bskBin || '',
        probe,
      });
      return attachBskMeta(session);
    } catch (err) {
      const reason = (err && typeof err.reason === 'string' && err.reason.trim())
        ? err.reason.trim()
        : redactSensitiveText(err instanceof Error ? err.message : String(err));
      return connectCdp(reason || 'bsk_connect_failed');
    }
  }

  const fallbackReason = (probe && probe.reason) ? String(probe.reason) : 'bsk_unavailable';
  return connectCdp(fallbackReason);
}
