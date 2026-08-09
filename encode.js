import fsp from 'node:fs/promises';
import path from 'node:path';
import { targetDims } from './media.js';

// Mirrors the ffmpeg invocations in docs/videosCompress.sh. Returns an argv array;
// it is never joined into a shell string, so filenames need no quoting or escaping.
export function buildEncodeArgs({ src, tmp, settings, width, height, audioCodec }) {
  const dims = targetDims(width, height, settings.targetShortSide);
  const q = String(settings.quality);

  const base = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-progress', 'pipe:1', '-nostats',
  ];

  let video;
  if (settings.encoder === 'vaapi') {
    video = [
      '-vaapi_device', settings.vaapiDevice,
      '-i', src,
      '-vf', `format=nv12,hwupload,scale_vaapi=w=${dims.width}:h=${dims.height}`,
      '-c:v', 'hevc_vaapi', '-rc_mode', 'CQP', '-qp', q,
    ];
  } else if (settings.encoder === 'qsv') {
    video = [
      '-init_hw_device', 'qsv=hw', '-filter_hw_device', 'hw',
      '-i', src,
      '-vf', `format=nv12,hwupload=extra_hw_frames=64,vpp_qsv=w=${dims.width}:h=${dims.height}`,
      '-c:v', 'hevc_qsv', '-global_quality', q,
    ];
  } else {
    video = [
      '-i', src,
      '-vf', `scale=${dims.width}:${dims.height}`,
      '-c:v', 'libx265', '-crf', q, '-preset', 'medium',
    ];
  }

  const audio = audioCodec === 'aac'
    ? ['-c:a', 'copy']
    : ['-c:a', 'aac', '-b:a', settings.audioBitrate, '-ac', '2'];

  // mp4 wins on compatibility but cannot carry the subtitle streams mkv can.
  const map = settings.container === 'mp4'
    ? ['-map', '0:v:0', '-map', '0:a?', '-sn', '-movflags', '+faststart', '-tag:v', 'hvc1']
    : ['-map', '0', '-c:s', 'copy'];

  return [...base, ...video, ...audio, ...map, tmp];
}

export const DURATION_TOLERANCE = 3;

// Nothing touches the original until all of these hold. Order matters: an ffmpeg
// failure is more informative than the empty file it leaves behind.
export function verifyEncode({ exitCode, tmpSize, origSize, origDuration, newDuration }) {
  if (exitCode !== 0) {
    return { status: 'failed', reason: `ffmpeg exited with code ${exitCode}` };
  }
  if (!tmpSize) {
    return { status: 'failed', reason: 'output file is missing or empty' };
  }
  if (!(origDuration > 0) || !(newDuration > 0)) {
    return { status: 'failed', reason: 'could not read duration of original or output' };
  }
  if (Math.abs(newDuration - origDuration) > DURATION_TOLERANCE) {
    return {
      status: 'failed',
      reason: `duration mismatch (original ${origDuration}s vs output ${newDuration}s)`,
    };
  }
  if (tmpSize >= origSize) {
    return {
      status: 'skipped',
      reason: `output not smaller (${origSize} -> ${tmpSize} bytes)`,
    };
  }
  return { status: 'done' };
}

// ffmpeg -progress writes key=value lines and terminates each block with
// `progress=continue` (or `progress=end`). Chunks arrive split at arbitrary offsets.
export function createProgressParser() {
  let buffer = '';
  let current = {};

  return function feed(chunk) {
    buffer += chunk;
    const blocks = [];
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      current[line.slice(0, eq)] = line.slice(eq + 1);
      if (line.slice(0, eq) === 'progress') {
        blocks.push(current);
        current = {};
      }
    }
    return blocks;
  };
}

export function percentFrom(block, durationSeconds) {
  const us = Number(block.out_time_us);
  if (!Number.isFinite(us) || !(durationSeconds > 0)) return null;
  return Math.min(100, Math.round((us / 1e6 / durationSeconds) * 100));
}

async function moveFile(from, to) {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    // .trash should be on the same filesystem, but a bind mount can break that.
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(from, to);
    await fsp.unlink(from);
  }
}

async function uniquePath(target) {
  let candidate = target;
  for (let n = 1; ; n++) {
    try {
      await fsp.access(candidate);
    } catch {
      return candidate;
    }
    candidate = `${target}.${n}`;
  }
}

// The original goes to trash before the new file lands, because a container change
// means the two have different names and would otherwise both exist.
export async function swapInPlace({ src, tmp, final, mediaRoot }) {
  const trashTarget = path.join(mediaRoot, '.trash', path.relative(mediaRoot, src));
  await fsp.mkdir(path.dirname(trashTarget), { recursive: true });
  const trashPath = await uniquePath(trashTarget);

  await moveFile(src, trashPath);
  try {
    await moveFile(tmp, final);
  } catch (err) {
    await moveFile(trashPath, src);
    throw err;
  }
  return trashPath;
}
