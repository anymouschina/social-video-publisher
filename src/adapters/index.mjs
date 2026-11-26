import * as xiaohongshu from './xiaohongshu.mjs';
import * as douyin from './douyin.mjs';
import * as x from './x.mjs';
import * as bilibili from './bilibili.mjs';

const CANONICAL_ADAPTERS = Object.freeze({
  xiaohongshu: xiaohongshu.default,
  douyin: douyin.default,
  x: x.default,
  bilibili: bilibili.default,
});

export const PLATFORM_ALIASES = Object.freeze({
  twitter: 'x',
  'x.com': 'x',
  推特: 'x',
  xhs: 'xiaohongshu',
  red: 'xiaohongshu',
  rednote: 'xiaohongshu',
  小红书: 'xiaohongshu',
  dy: 'douyin',
  抖音: 'douyin',
  'b站': 'bilibili',
  bili: 'bilibili',
  哔哩哔哩: 'bilibili',
});

/**
 * Adapter registry keyed by canonical platform ID (enumerable),
 * with non-enumerable alias properties (`twitter`, `xhs`, `dy`, `b站`, etc.)
 * so `Object.keys(ADAPTERS)` only lists unique canonical platforms while direct
 * alias lookups like `ADAPTERS.twitter` or `ADAPTERS['b站']` also resolve.
 */
const adaptersMap = {
  xiaohongshu: CANONICAL_ADAPTERS.xiaohongshu,
  douyin: CANONICAL_ADAPTERS.douyin,
  x: CANONICAL_ADAPTERS.x,
  bilibili: CANONICAL_ADAPTERS.bilibili,
};

for (const [alias, targetId] of Object.entries(PLATFORM_ALIASES)) {
  if (!(alias in adaptersMap)) {
    Object.defineProperty(adaptersMap, alias, {
      value: CANONICAL_ADAPTERS[targetId],
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
}

export const ADAPTERS = Object.freeze(adaptersMap);

/**
 * Normalize a raw platform name or alias to its canonical platform ID.
 *
 * @param {unknown} raw
 * @returns {'xiaohongshu' | 'douyin' | 'x' | 'bilibili' | null}
 */
export function resolvePlatformId(raw) {
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (Object.prototype.hasOwnProperty.call(CANONICAL_ADAPTERS, normalized)) {
    return normalized;
  }
  if (Object.prototype.hasOwnProperty.call(PLATFORM_ALIASES, normalized)) {
    return PLATFORM_ALIASES[normalized];
  }
  return null;
}

/**
 * Look up a platform adapter by canonical ID or alias.
 *
 * @param {unknown} id
 */
export function getAdapter(id) {
  const canonicalId = resolvePlatformId(id);
  return canonicalId ? CANONICAL_ADAPTERS[canonicalId] : null;
}

/**
 * Return the list of canonical platform specs in display order.
 */
export function listPlatformSpecs() {
  return Object.values(CANONICAL_ADAPTERS).map((adapter) => adapter.spec);
}

export { xiaohongshu, douyin, x, bilibili };
