import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ALLOWED_COVER_EXTENSIONS,
  ALLOWED_VIDEO_EXTENSIONS,
  enrichedPath,
} from './constants.mjs';

const execFileAsync = promisify(execFile);
const FFPROBE_TIMEOUT_MS = 10_000;

export async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function parseFrameRate(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const parts = raw.split('/');
  if (parts.length === 2) {
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      return Number((num / den).toFixed(2));
    }
    return null;
  }
  const single = Number(raw);
  return Number.isFinite(single) && single > 0 ? Number(single.toFixed(2)) : null;
}

async function tryFfprobe(filePath, env = process.env) {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      {
        env: { ...env, PATH: enrichedPath(env) },
        timeout: FFPROBE_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    const parsed = JSON.parse(stdout || '{}');
    const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
    const videoStream = streams.find((s) => s && s.codec_type === 'video') || null;
    const audioStream = streams.find((s) => s && s.codec_type === 'audio') || null;
    const format = parsed.format || {};

    const durationRaw = Number(format.duration ?? videoStream?.duration);
    const durationSec = Number.isFinite(durationRaw) && durationRaw > 0
      ? Number(durationRaw.toFixed(2))
      : null;

    const width = Number.isFinite(Number(videoStream?.width)) && Number(videoStream.width) > 0
      ? Number(videoStream.width)
      : null;
    const height = Number.isFinite(Number(videoStream?.height)) && Number(videoStream.height) > 0
      ? Number(videoStream.height)
      : null;

    const bitrateRaw = Number(format.bit_rate ?? videoStream?.bit_rate);
    const bitrateKbps = Number.isFinite(bitrateRaw) && bitrateRaw > 0
      ? Math.round(bitrateRaw / 1000)
      : null;

    return {
      ffprobeAvailable: true,
      probedBy: 'ffprobe',
      durationSec,
      width,
      height,
      aspectRatio: width && height ? `${width}:${height}` : null,
      fps: parseFrameRate(videoStream?.avg_frame_rate || videoStream?.r_frame_rate),
      videoCodec: videoStream?.codec_name || null,
      audioCodec: audioStream?.codec_name || null,
      bitrateKbps,
      formatName: format.format_name || null,
    };
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : '';
    return {
      ffprobeAvailable: code !== 'ENOENT',
      probedBy: 'stat',
      durationSec: null,
      width: null,
      height: null,
      aspectRatio: null,
      fps: null,
      videoCodec: null,
      audioCodec: null,
      bitrateKbps: null,
      formatName: null,
      probeNote: code === 'ENOENT'
        ? 'ffprobe 未安装，已降级为基础文件属性检查'
        : `ffprobe 检测失败，已降级为基础文件属性检查（${error instanceof Error ? error.message : String(error)}）`,
    };
  }
}

export async function probeMediaFile(filePath, opts = {}) {
  const kind = opts.kind === 'cover' ? 'cover' : 'video';
  const env = opts.env || process.env;
  const raw = String(filePath || '').trim();
  if (!raw) {
    return {
      ok: false,
      kind,
      error: kind === 'cover' ? '封面文件路径为空' : '视频文件路径为空',
    };
  }

  const resolvedPath = path.resolve(raw);
  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    return {
      ok: false,
      kind,
      path: resolvedPath,
      error: `文件不存在或无法读取：${resolvedPath}`,
    };
  }

  if (!stat.isFile()) {
    return {
      ok: false,
      kind,
      path: resolvedPath,
      error: `目标路径不是普通文件：${resolvedPath}`,
    };
  }

  if (stat.size <= 0) {
    return {
      ok: false,
      kind,
      path: resolvedPath,
      sizeBytes: 0,
      error: `文件为空（0 字节）：${resolvedPath}`,
    };
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  const allowed = kind === 'cover' ? ALLOWED_COVER_EXTENSIONS : ALLOWED_VIDEO_EXTENSIONS;
  const warnings = [];
  if (!allowed.includes(ext)) {
    warnings.push(
      `文件扩展名 ${ext || '(无)'} 不在常见${kind === 'cover' ? '封面' : '视频'}格式列表中（推荐：${allowed.join(', ')}）`,
    );
  }

  const sha256 = await sha256File(resolvedPath);
  const sizeMb = Number((stat.size / (1024 * 1024)).toFixed(2));

  const base = {
    ok: true,
    kind,
    path: resolvedPath,
    fileName: path.basename(resolvedPath),
    ext,
    sizeBytes: stat.size,
    sizeMb,
    sha256,
    warnings,
  };

  if (kind === 'video' && opts.skipFfprobe !== true) {
    const ff = await tryFfprobe(resolvedPath, env);
    if (ff.probeNote) warnings.push(ff.probeNote);
    return { ...base, ...ff };
  }

  return {
    ...base,
    ffprobeAvailable: false,
    probedBy: 'stat',
  };
}
