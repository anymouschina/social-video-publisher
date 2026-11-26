import fs from 'node:fs';
import path from 'node:path';
import { redactSensitiveText, resolveDataDir } from './constants.mjs';

function sanitizeId(raw) {
  const clean = String(raw || '').trim().replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!clean) throw new Error('Invalid storage identifier');
  return clean;
}

function sanitizeValue(value) {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/cookie|authorization|token|password|secret/i.test(k) && typeof v === 'string') {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeValue(v);
      }
    }
    return out;
  }
  return value;
}

export class LocalStorage {
  constructor(opts = {}) {
    this.dataDir = path.resolve(opts.dataDir || resolveDataDir(opts.env));
    this.plansDir = path.join(this.dataDir, 'plans');
    this.jobsDir = path.join(this.dataDir, 'jobs');
    this.screenshotsDir = path.join(this.dataDir, 'screenshots');
    this.historyFile = path.join(this.dataDir, 'history.jsonl');
  }

  ensureDirs() {
    fs.mkdirSync(this.plansDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.screenshotsDir, { recursive: true, mode: 0o700 });
  }

  getScreenshotDir(jobId) {
    this.ensureDirs();
    const dir = path.join(this.screenshotsDir, sanitizeId(jobId));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  savePlan(plan) {
    this.ensureDirs();
    const id = sanitizeId(plan.planId);
    const filePath = path.join(this.plansDir, `${id}.json`);
    const safe = sanitizeValue(plan);
    fs.writeFileSync(filePath, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 });
    return safe;
  }

  getPlan(planId) {
    try {
      const filePath = path.join(this.plansDir, `${sanitizeId(planId)}.json`);
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  saveJob(job) {
    this.ensureDirs();
    const id = sanitizeId(job.jobId);
    const filePath = path.join(this.jobsDir, `${id}.json`);
    const safe = sanitizeValue(job);
    const tmpPath = `${filePath}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    return safe;
  }

  getJob(jobId) {
    try {
      const filePath = path.join(this.jobsDir, `${sanitizeId(jobId)}.json`);
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  appendHistory(entry) {
    this.ensureDirs();
    const safe = sanitizeValue(entry);
    fs.appendFileSync(this.historyFile, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
    return safe;
  }

  readAllHistory() {
    if (!fs.existsSync(this.historyFile)) return [];
    const lines = fs.readFileSync(this.historyFile, 'utf8').split(/\r?\n/);
    const records = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        // Ignore corrupted partial line if process was killed mid-write.
      }
    }
    return records;
  }

  listHistory({ limit = 20, platform = null } = {}) {
    const cleanLimit = Math.max(1, Math.min(200, Number(limit) || 20));
    const all = this.readAllHistory();
    const filtered = platform
      ? all.filter((item) => item && item.platform === platform)
      : all;
    return filtered.slice(-cleanLimit).reverse();
  }

  findDuplicates(videoSha256, platforms = []) {
    if (!videoSha256) return [];
    const wanted = new Set(platforms.filter(Boolean));
    const meaningfulStatuses = new Set(['published', 'scheduled', 'draft_saved']);
    const matches = [];
    for (const item of this.readAllHistory()) {
      if (!item || item.videoSha256 !== videoSha256) continue;
      if (wanted.size > 0 && !wanted.has(item.platform)) continue;
      if (!meaningfulStatuses.has(item.status)) continue;
      matches.push({
        platform: item.platform,
        status: item.status,
        mode: item.mode,
        url: item.url || null,
        title: item.title || '',
        createdAt: item.createdAt || null,
        jobId: item.jobId || null,
      });
    }
    return matches.reverse();
  }
}
