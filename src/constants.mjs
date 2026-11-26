import os from 'node:os';
import path from 'node:path';

export const PLUGIN_NAME = 'social-video-publisher';
export const PLUGIN_VERSION = '0.2.0';
export const MCP_SERVER_NAME = 'social_pub';
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * Platforms whose session cookies are cryptographically or device-bound
 * (e.g., Douyin `bd_ticket_guard` WebCrypto IndexedDB keys & DBSC,
 * Xiaohongshu device tokens, X `cf_clearance`). Transplanting raw cookies
 * from another browser profile poisons the session and triggers forced logout
 * or captcha challenges, so cross-profile `cookieFiles` injection is blocked
 * by default unless `allowUnsafeCookieInjection: true` is explicitly passed.
 */
export const DEVICE_BOUND_COOKIE_PLATFORMS = Object.freeze(new Set(['douyin', 'xiaohongshu', 'x']));

export const DEFAULT_WAIT_SECONDS = 25;
export const MIN_WAIT_SECONDS = 0;
export const MAX_WAIT_SECONDS = 45;

export const ALLOWED_VIDEO_EXTENSIONS = Object.freeze([
  '.mp4',
  '.mov',
  '.m4v',
  '.webm',
  '.mkv',
  '.avi',
  '.flv',
]);

export const ALLOWED_COVER_EXTENSIONS = Object.freeze([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
]);

export const PLATFORM_COOKIE_DOMAINS = Object.freeze({
  xiaohongshu: {
    defaultDomain: '.xiaohongshu.com',
    domains: ['xiaohongshu.com', 'creator.xiaohongshu.com', 'rednote.com'],
  },
  douyin: {
    defaultDomain: '.douyin.com',
    domains: ['douyin.com', 'creator.douyin.com', 'iesdouyin.com'],
  },
  x: {
    defaultDomain: '.x.com',
    domains: ['x.com', 'twitter.com'],
  },
  bilibili: {
    defaultDomain: '.bilibili.com',
    domains: ['bilibili.com', 'member.bilibili.com', 'passport.bilibili.com'],
  },
});

const SENSITIVE_COOKIE_NAMES = [
  'web_session',
  'a1',
  'id_token',
  'access_token',
  'sessionid',
  'sessionid_ss',
  'sid_tt',
  'd_ticket',
  'x_tt_token',
  'bd_ticket_guard_client_data',
  '_bd_ticket_crypt_cookie',
  'UIFID',
  'passport_csrf_token',
  'auth_token',
  'ct0',
  'twid',
  'cf_clearance',
  'SESSDATA',
  'bili_jct',
  'DedeUserID',
  'sid',
];

export function resolveDataDir(env = process.env) {
  const override = String(env.SOCIAL_PUB_DATA_DIR || '').trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), '.local', 'share', PLUGIN_NAME);
}

export function resolveProfileDir(env = process.env) {
  const override = String(env.SOCIAL_PUB_PROFILE_DIR || '').trim();
  if (override) return path.resolve(override);
  return path.join(resolveDataDir(env), 'chrome-profile');
}

export function enrichedPath(env = process.env, platform = process.platform, home = os.homedir()) {
  const sep = platform === 'win32' ? ';' : ':';
  const current = String(env.PATH || '').split(sep).filter(Boolean);
  const extras = platform === 'win32'
    ? []
    : [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        path.join(home, '.local', 'bin'),
        '/usr/bin',
        '/bin',
      ];
  const seen = new Set();
  const merged = [];
  for (const entry of [...current, ...extras]) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  return merged.join(sep);
}

export function clampWaitSeconds(raw, fallback = DEFAULT_WAIT_SECONDS) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const num = Number(raw);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(MIN_WAIT_SECONDS, Math.min(MAX_WAIT_SECONDS, Math.round(num)));
}

export function redactSensitiveText(input, extraSecrets = []) {
  let text = String(input ?? '');
  if (!text) return '';

  for (const secret of extraSecrets) {
    const clean = String(secret || '').trim();
    if (clean.length >= 4) {
      text = text.split(clean).join('[REDACTED_COOKIE]');
    }
  }

  // Redact explicit Cookie / Set-Cookie / Authorization headers
  text = text.replace(/((?:set-)?cookie\s*[:=]\s*)([^\r\n]+)/gi, '$1[REDACTED_COOKIE]');
  text = text.replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)([^\s\r\n]+)/gi, '$1[REDACTED]');

  // Redact known auth cookie key=value pairs
  const namesPattern = SENSITIVE_COOKIE_NAMES.join('|');
  const kvRegex = new RegExp(`(\\b(?:${namesPattern})\\s*=\\s*)([^;\\s"',}]+)`, 'gi');
  text = text.replace(kvRegex, '$1[REDACTED_COOKIE]');

  return text;
}
