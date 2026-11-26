/**
 * Clean-room human-like input kinematics and pacing primitives.
 * Zero third-party dependencies, pure Node.js ESM.
 *
 * NOTE: `SOCIAL_PUB_FAST_HUMAN=1` / `opts.fastMode = true` is strictly for
 * unit tests so test suites complete in <2s while production runs always use
 * full realistic human timings.
 */

const CJK_OR_NON_ASCII_RE = /[^\x00-\x7F]/;
const PAUSE_PUNCT_RE = /^[，。！？；：、…—,.!?;:\n]$/;
const THINK_AFTER_ASCII_RE = /^[ ,.!?;:\n]$/;

/**
 * Returns true only when test fast-mode is explicitly requested.
 *
 * @param {{ fastMode?: boolean }} [opts]
 * @returns {boolean}
 */
export function isFastHumanMode(opts = {}) {
  return opts?.fastMode === true || process.env.SOCIAL_PUB_FAST_HUMAN === '1';
}

/**
 * Uniform float in [min, max).
 *
 * @param {number} min
 * @param {number} max
 * @param {() => number} [rng=Math.random]
 * @returns {number}
 */
export function randFloat(min, max, rng = Math.random) {
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  if (low === high) return low;
  return low + rng() * (high - low);
}

/**
 * Inclusive random integer in [min, max].
 *
 * @param {number} min
 * @param {number} max
 * @param {() => number} [rng=Math.random]
 * @returns {number}
 */
export function randInt(min, max, rng = Math.random) {
  const low = Math.ceil(Math.min(min, max));
  const high = Math.floor(Math.max(min, max));
  if (low >= high) return low;
  return Math.floor(rng() * (high - low + 1)) + low;
}

/**
 * Jitters a base duration by +/- ratio (default +/- 25%).
 *
 * @param {number} baseMs
 * @param {number} [ratio=0.25]
 * @param {() => number} [rng=Math.random]
 * @returns {number}
 */
export function jitterDelay(baseMs, ratio = 0.25, rng = Math.random) {
  const base = Number(baseMs);
  if (!Number.isFinite(base) || base <= 0) return 0;
  const clampedRatio = Math.max(0, Math.min(0.95, Number(ratio) || 0));
  const factor = 1 + (rng() * 2 - 1) * clampedRatio;
  return Math.max(1, Math.round(base * factor));
}

/**
 * Sleeps for `ms` milliseconds, compressed to 0ms only in explicit test fastMode.
 *
 * @param {number} ms
 * @param {{ fastMode?: boolean }} [opts]
 * @returns {Promise<void>}
 */
export function humanSleep(ms, opts = {}) {
  if (isFastHumanMode(opts)) {
    return Promise.resolve();
  }
  const safeMs = Math.max(0, Math.round(Number(ms) || 0));
  if (safeMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, safeMs));
}

/**
 * Samples a natural interior point inside [22%, 78%] of `rect` using an
 * Irwin-Hall (sum of 3 uniforms) distribution biased toward the middle third,
 * avoiding exact geometric center when the element is large enough.
 *
 * Accepts either `{ left, top, width, height }` or `{ x, y, width, height }`.
 *
 * @param {{ left?: number, top?: number, x?: number, y?: number, width: number, height: number }} rect
 * @param {{ rng?: () => number }} [opts]
 * @returns {{ x: number, y: number }}
 */
export function sampleInteriorPoint(rect, opts = {}) {
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const originX = Number.isFinite(rect?.left) ? rect.left : (Number.isFinite(rect?.x) ? rect.x : 0);
  const originY = Number.isFinite(rect?.top) ? rect.top : (Number.isFinite(rect?.y) ? rect.y : 0);
  const width = Math.max(1, Number(rect?.width) || 1);
  const height = Math.max(1, Number(rect?.height) || 1);

  const minX = originX + width * 0.22;
  const maxX = originX + width * 0.78;
  const minY = originY + height * 0.22;
  const maxY = originY + height * 0.78;

  // Irwin-Hall(3) normalized to [0, 1] gives a smooth bell-shaped interior bias.
  const uX = (rng() + rng() + rng()) / 3;
  const uY = (rng() + rng() + rng()) / 3;

  let x = minX + uX * (maxX - minX);
  let y = minY + uY * (maxY - minY);

  const centerX = originX + width / 2;
  const centerY = originY + height / 2;

  // Never land on the exact geometric center when box dimensions allow an offset.
  if (
    Math.round(x) === Math.round(centerX) &&
    Math.round(y) === Math.round(centerY) &&
    (maxX - minX >= 2 || maxY - minY >= 2)
  ) {
    const dirX = rng() < 0.5 ? -1 : 1;
    const dirY = rng() < 0.5 ? -1 : 1;
    if (maxX - minX >= 2) {
      x = Math.min(maxX, Math.max(minX, x + dirX * Math.max(1, width * 0.05)));
    }
    if (maxY - minY >= 2) {
      y = Math.min(maxY, Math.max(minY, y + dirY * Math.max(1, height * 0.05)));
    }
  }

  // Clamp strictly within [minX, maxX] and [minY, maxY] after rounding.
  const clampRounded = (val, lo, hi) => {
    const rounded = Math.round(val);
    const loInt = Math.ceil(lo);
    const hiInt = Math.floor(hi);
    if (loInt <= hiInt) {
      return Math.min(hiInt, Math.max(loInt, rounded));
    }
    return Math.min(hi, Math.max(lo, val));
  };

  return {
    x: clampRounded(x, minX, maxX),
    y: clampRounded(y, minY, maxY),
  };
}

/**
 * Minimum-jerk velocity profile: 10t^3 - 15t^4 + 6t^5.
 *
 * @param {number} t
 * @returns {number}
 */
function minimumJerk(t) {
  const c = Math.max(0, Math.min(1, t));
  return c * c * c * (10 + c * (-15 + c * 6));
}

/**
 * Evaluates a cubic Bezier curve at parameter `t`.
 */
function cubicBezier(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

/**
 * Generates a realistic human cubic Bezier pointer trajectory from `from` to `to`:
 * - 2 randomized perpendicular control points (+/- 8%–22% arc deviation)
 * - Fitts's Law step count: max(12, min(48, round(dist / rand(14, 24))))
 * - Minimum-jerk easing (10t^3 - 15t^4 + 6t^5)
 * - Decaying micro-jitter (+/- 0.8–1.8px -> 0 at endpoint)
 * - ~25% subtle overshoot (3–9px) + 3–6 corrective micro-steps on long moves (>250px)
 * - Variable 8–22ms step cadence
 *
 * @param {{ x: number, y: number }} from
 * @param {{ x: number, y: number }} to
 * @param {{ rng?: () => number, overshootChance?: number }} [opts]
 * @returns {Array<{ x: number, y: number, delayMs: number }>}
 */
export function buildBezierPath(from, to, opts = {}) {
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const overshootChance = Number.isFinite(opts.overshootChance) ? opts.overshootChance : 0.25;

  const p0 = { x: Number(from?.x) || 0, y: Number(from?.y) || 0 };
  const target = { x: Number(to?.x) || 0, y: Number(to?.y) || 0 };

  const dx = target.x - p0.x;
  const dy = target.y - p0.y;
  const dist = Math.hypot(dx, dy);

  if (dist < 1) {
    return [{ x: Math.round(target.x), y: Math.round(target.y), delayMs: randInt(8, 16, rng) }];
  }

  const shouldOvershoot = dist > 250 && rng() < overshootChance;
  const ux = dx / dist;
  const uy = dy / dist;
  const nx = -uy;
  const ny = ux;

  let mainEnd = target;
  if (shouldOvershoot) {
    const overDist = randFloat(3, 9, rng);
    const lateral = randFloat(-2, 2, rng);
    mainEnd = {
      x: target.x + ux * overDist + nx * lateral,
      y: target.y + uy * overDist + ny * lateral,
    };
  }

  const mainDx = mainEnd.x - p0.x;
  const mainDy = mainEnd.y - p0.y;
  const mainDist = Math.hypot(mainDx, mainDy);

  const steps = Math.max(12, Math.min(48, Math.round(mainDist / randFloat(14, 24, rng))));

  const t1 = randFloat(0.22, 0.40, rng);
  const t2 = randFloat(0.62, 0.82, rng);
  const sign1 = rng() < 0.5 ? -1 : 1;
  const sign2 = rng() < 0.78 ? sign1 : -sign1;
  const dev1 = Math.min(180, mainDist * randFloat(0.08, 0.22, rng));
  const dev2 = Math.min(180, mainDist * randFloat(0.08, 0.22, rng));

  const p1 = {
    x: p0.x + mainDx * t1 + nx * sign1 * dev1,
    y: p0.y + mainDy * t1 + ny * sign1 * dev1,
  };
  const p2 = {
    x: p0.x + mainDx * t2 + nx * sign2 * dev2,
    y: p0.y + mainDy * t2 + ny * sign2 * dev2,
  };

  const points = [];
  for (let i = 1; i <= steps; i += 1) {
    const u = i / steps;
    const eased = minimumJerk(u);
    const base = cubicBezier(p0, p1, p2, mainEnd, eased);

    const isLastMain = i === steps;
    let jx = 0;
    let jy = 0;
    if (!isLastMain) {
      const decay = 1 - u;
      const amp = randFloat(0.8, 1.8, rng) * decay;
      jx = (rng() * 2 - 1) * amp;
      jy = (rng() * 2 - 1) * amp;
    }

    // Subtle human cadence: slightly slower near acceleration/deceleration endpoints, within 8–22ms.
    const edgeWeight = Math.abs(u - 0.5) * 2; // 0 in middle, 1 at ends
    const minCadence = Math.round(8 + edgeWeight * 4);
    const maxCadence = Math.round(16 + edgeWeight * 6);
    const delayMs = Math.max(8, Math.min(22, randInt(minCadence, maxCadence, rng)));

    points.push({
      x: Math.max(0, Math.round(base.x + jx)),
      y: Math.max(0, Math.round(base.y + jy)),
      delayMs,
    });
  }

  if (shouldOvershoot) {
    const settleSteps = randInt(3, 6, rng);
    const startSettle = points[points.length - 1];
    for (let j = 1; j <= settleSteps; j += 1) {
      const u = j / settleSteps;
      const eased = minimumJerk(u);
      const isFinal = j === settleSteps;
      const x = isFinal
        ? Math.round(target.x)
        : Math.max(0, Math.round(startSettle.x + (target.x - startSettle.x) * eased));
      const y = isFinal
        ? Math.round(target.y)
        : Math.max(0, Math.round(startSettle.y + (target.y - startSettle.y) * eased));
      points.push({
        x,
        y,
        delayMs: randInt(10, 22, rng),
      });
    }
  } else {
    points[points.length - 1].x = Math.max(0, Math.round(target.x));
    points[points.length - 1].y = Math.max(0, Math.round(target.y));
  }

  return points;
}

/**
 * Splits text into realistic human typing actions:
 * - ASCII / Latin / digits / punctuation / newlines -> char-by-char `kind: 'key'`
 *   (`holdMs: 35–95`, `delayMs: 50–155`, occasional `220–480ms` thinking pause)
 * - CJK / Emoji / non-ASCII -> natural 1–4 char phrase chunks `kind: 'ime'`
 *   (`preDelayMs: 120–290`, `delayMs: 60–160` or `300–680ms` after punctuation/newlines)
 *
 * Never dumps a long paragraph in a single 0ms call.
 *
 * @param {unknown} text
 * @param {{ rng?: () => number }} [opts]
 * @returns {Array<{ kind: 'key', text: string, holdMs: number, delayMs: number } | { kind: 'ime', text: string, preDelayMs: number, delayMs: number }>}
 */
export function buildTypingPlan(text, opts = {}) {
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  // Normalize CRLF and bare CR to LF so newlines never emit a malformed '\r' + Enter double break.
  const str = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!str) return [];

  const chars = Array.from(str);
  const plan = [];
  let asciiSincePause = 0;
  let nextPauseAt = randInt(12, 28, rng);
  let idx = 0;

  while (idx < chars.length) {
    const ch = chars[idx];
    const isNonAscii = CJK_OR_NON_ASCII_RE.test(ch);

    if (!isNonAscii) {
      asciiSincePause += 1;
      const holdMs = randInt(35, 95, rng);
      let delayMs = randInt(50, 155, rng);

      const isBoundary = THINK_AFTER_ASCII_RE.test(ch);
      if ((isBoundary && rng() < 0.22) || asciiSincePause >= nextPauseAt) {
        delayMs = randInt(220, 480, rng);
        asciiSincePause = 0;
        nextPauseAt = randInt(12, 28, rng);
      }

      plan.push({
        kind: 'key',
        text: ch,
        holdMs,
        delayMs,
      });
      idx += 1;
      continue;
    }

    // Group non-ASCII (CJK / emoji / fullwidth) into natural 1–4 char IME phrases.
    const maxChunk = randInt(1, 4, rng);
    let chunk = '';
    let endsWithPunct = false;

    while (idx < chars.length && Array.from(chunk).length < maxChunk) {
      const cur = chars[idx];
      if (!CJK_OR_NON_ASCII_RE.test(cur)) break;
      chunk += cur;
      idx += 1;
      if (PAUSE_PUNCT_RE.test(cur)) {
        endsWithPunct = true;
        break;
      }
    }

    // Check if immediately followed by an ASCII newline/punctuation to add thinking pause.
    const nextChar = idx < chars.length ? chars[idx] : '';
    const extraPause = endsWithPunct || nextChar === '\n';

    plan.push({
      kind: 'ime',
      text: chunk,
      preDelayMs: randInt(120, 290, rng),
      delayMs: extraPause ? randInt(300, 680, rng) : randInt(60, 160, rng),
    });
    asciiSincePause = 0;
  }

  return plan;
}

/**
 * Splits a vertical scroll delta into 3–8 realistic variable `mouseWheel` chunks
 * (`90–260px` per chunk when distance permits, `45–120ms` apart).
 *
 * @param {number} deltaY
 * @param {{ rng?: () => number }} [opts]
 * @returns {Array<{ deltaY: number, delayMs: number }>}
 */
export function buildWheelChunks(deltaY, opts = {}) {
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const total = Math.round(Number(deltaY) || 0);
  if (total === 0) return [];

  const sign = total < 0 ? -1 : 1;
  const absTotal = Math.abs(total);

  // Tiny deltas (<3px) cannot split into 3+ positive integer chunks without sign reversal.
  if (absTotal < 3) {
    return [{ deltaY: total, delayMs: randInt(45, 120, rng) }];
  }

  // Target 3–8 chunks; keep each chunk within ~90–260px whenever absTotal >= 270.
  let count;
  if (absTotal < 270) {
    count = Math.min(absTotal, randInt(3, 5, rng));
  } else {
    const minChunks = Math.max(3, Math.ceil(absTotal / 260));
    const maxChunks = Math.min(8, Math.max(minChunks, Math.floor(absTotal / 90)));
    count = Math.min(8, Math.max(3, randInt(Math.min(minChunks, 8), Math.min(maxChunks, 8), rng)));
  }

  const weights = [];
  let weightSum = 0;
  for (let i = 0; i < count; i += 1) {
    const w = randFloat(0.65, 1.35, rng);
    weights.push(w);
    weightSum += w;
  }

  const chunks = [];
  let allocated = 0;
  for (let i = 0; i < count; i += 1) {
    const isLast = i === count - 1;
    let mag;
    if (isLast) {
      mag = absTotal - allocated;
    } else {
      mag = Math.max(1, Math.round((absTotal * weights[i]) / weightSum));
      // Keep remaining chunks positive
      const remainingSlots = count - i - 1;
      mag = Math.min(mag, absTotal - allocated - remainingSlots);
    }
    allocated += mag;
    chunks.push({
      deltaY: sign * mag,
      delayMs: randInt(45, 120, rng),
    });
  }

  return chunks;
}
