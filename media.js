import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

export function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Resolve a client-supplied relative path against the media root, and prove the
// result is still inside it. realpath is the point of this function: a plain
// string-prefix check on the joined path would happily follow a symlink out.
export function resolveSafe(root, rel) {
  const realRoot = fs.realpathSync(root);
  const joined = path.resolve(realRoot, rel == null ? '' : String(rel));
  let real;
  try {
    real = fs.realpathSync(joined);
  } catch {
    throw badRequest(`no such path: ${rel}`);
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw badRequest(`path escapes media root: ${rel}`);
  }
  return real;
}

// Hardware encoders reject odd dimensions.
export function evenDown(n) {
  return Math.floor(n / 2) * 2;
}

export function wouldReduce(width, height, targetShortSide) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  return Math.min(width, height) > targetShortSide;
}

// Scale the shorter side to the target, preserve aspect ratio, keep both sides even.
export function targetDims(width, height, targetShortSide) {
  const target = evenDown(targetShortSide);
  if (width >= height) {
    return { width: evenDown((width * target) / height), height: target };
  }
  return { width: target, height: evenDown((height * target) / width) };
}

const run = promisify(execFile);

export const VIDEO_EXTENSIONS = [
  'mkv', 'mp4', 'avi', 'mov', 'wmv', 'flv', 'm4v', 'mpg', 'mpeg', 'ts', 'm2ts', 'webm',
];

const TRASH_DIR = '.trash';

function isVideo(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return VIDEO_EXTENSIONS.includes(ext);
}

// JSON rather than the script's CSV: ffprobe fixes CSV field order itself, which is
// easy to read back in the wrong order. One call gets both stream and format data —
// the ':' separates sections in a single -show_entries argument.
export async function probeVideo(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height:format=duration',
    '-of', 'json',
    file,
  ]);
  const data = JSON.parse(stdout);
  const stream = data.streams?.[0];
  if (!stream || !Number.isFinite(stream.width) || !Number.isFinite(stream.height)) return null;
  return {
    codec: stream.codec_name ?? null,
    width: stream.width,
    height: stream.height,
    duration: Number(data.format?.duration) || null,
  };
}

export async function probeAudioCodec(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name',
    '-of', 'default=nw=1:nk=1',
    file,
  ]);
  return stdout.trim() || null;
}

export async function listDirs(absDir) {
  const entries = await fsp.readdir(absDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(absDir, e.name))
    .sort();
}

async function walk(dir, out) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    // Unreadable (EACCES) or gone (ENOENT, the worker moving files into .trash
    // mid-scan): skip the directory rather than 500 the whole listing.
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === TRASH_DIR) continue;
      await walk(full, out);
    } else if (entry.isFile() && !entry.name.startsWith('.') && isVideo(entry.name)) {
      out.push(full);
    }
  }
}

// Bounded-concurrency map. ffprobe on a few thousand files serially is minutes;
// four at a time is seconds and still leaves the disk usable.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function scanTree(absDir, { probe = probeVideo, concurrency = 4 } = {}) {
  const files = [];
  await walk(absDir, files);
  files.sort();

  const scanned = await pool(files, concurrency, async (file) => {
    // A file the worker trashed between the walk and here drops out of the
    // results; one vanished file must not reject the whole scan.
    const size = await fsp.stat(file).then((s) => s.size, () => null);
    if (size === null) return null;
    let info = null;
    try {
      info = await probe(file);
    } catch {
      info = null;
    }
    return {
      path: file,
      size,
      codec: info?.codec ?? null,
      width: info?.width ?? null,
      height: info?.height ?? null,
      duration: info?.duration ?? null,
      probeError: info === null,
    };
  });

  return scanned.filter(Boolean);
}
