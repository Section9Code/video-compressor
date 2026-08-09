import { spawn as nodeSpawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { getSettings, nextWaiting, updateJob } from './db.js';
import { buildEncodeArgs, createProgressParser, percentFrom, swapInPlace, verifyEncode } from './encode.js';
import { probeAudioCodec as realProbeAudio, probeVideo as realProbeVideo } from './media.js';

const STDERR_TAIL_BYTES = 4096;

export function tempPathFor(src, container) {
  const dir = path.dirname(src);
  const name = path.basename(src, path.extname(src));
  return path.join(dir, `.${name}.tmp.${container}`);
}

export function finalPathFor(src, container) {
  const dir = path.dirname(src);
  const name = path.basename(src, path.extname(src));
  return path.join(dir, `${name}.${container}`);
}

async function unlinkQuietly(file) {
  await fsp.unlink(file).catch(() => {});
}

export async function cleanupTempFiles(rows) {
  for (const row of rows) {
    const container = JSON.parse(row.settings_json).container;
    await unlinkQuietly(tempPathFor(row.path, container));
  }
}

// Runs ffmpeg and reports progress. Resolves with the exit code and the stderr tail.
function runFfmpeg({ spawn, args, durationSeconds, onProgress }) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args);
    const feed = createProgressParser();
    let stderr = '';

    child.stdout.setEncoding?.('utf8');
    child.stderr.setEncoding?.('utf8');

    child.stdout.on('data', (chunk) => {
      for (const block of feed(String(chunk))) {
        onProgress({ percent: percentFrom(block, durationSeconds), bitrate: block.bitrate ?? null });
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-STDERR_TAIL_BYTES);
    });

    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ exitCode, stderr }));
  });
}

export async function runJob(db, job, deps) {
  const {
    mediaRoot,
    spawn = nodeSpawn,
    probeVideo = realProbeVideo,
    probeAudioCodec = realProbeAudio,
    now = Date.now,
    progressIntervalMs = 1000,
  } = deps;

  // Undefined until the try block sets it, so a throw before that point (e.g. a
  // corrupted settings_json) has nothing to unlink.
  let tmp;

  const fail = async (reason) => {
    if (tmp) await unlinkQuietly(tmp);
    updateJob(db, job.id, { status: 'failed', error: reason, finished_at: now() });
  };

  try {
    const settings = JSON.parse(job.settings_json);
    tmp = tempPathFor(job.path, settings.container);
    const final = finalPathFor(job.path, settings.container);

    updateJob(db, job.id, { status: 'processing', progress: 0, bitrate: null, error: null, started_at: now() });

    const origSize = (await fsp.stat(job.path)).size;
    const audioCodec = await probeAudioCodec(job.path);

    const args = buildEncodeArgs({
      src: job.path,
      tmp,
      settings,
      width: job.width,
      height: job.height,
      audioCodec,
    });

    let lastWrite = 0;
    const { exitCode, stderr } = await runFfmpeg({
      spawn,
      args,
      durationSeconds: job.duration,
      onProgress: ({ percent, bitrate }) => {
        const t = now();
        if (t - lastWrite < progressIntervalMs) return;
        lastWrite = t;
        updateJob(db, job.id, { progress: percent ?? 0, bitrate });
      },
    });

    const tmpSize = await fsp.stat(tmp).then((s) => s.size, () => 0);
    const newInfo = tmpSize ? await probeVideo(tmp).catch(() => null) : null;

    const result = verifyEncode({
      exitCode,
      tmpSize,
      origSize,
      origDuration: job.duration,
      newDuration: newInfo?.duration ?? null,
    });

    if (result.status === 'failed') {
      return await fail(stderr.trim() ? `${result.reason}\n${stderr.trim()}` : result.reason);
    }

    if (result.status === 'skipped') {
      await unlinkQuietly(tmp);
      updateJob(db, job.id, {
        status: 'skipped', error: result.reason, new_size: tmpSize, finished_at: now(),
      });
      return;
    }

    const trashPath = await swapInPlace({ src: job.path, tmp, final, mediaRoot });
    updateJob(db, job.id, {
      status: 'done',
      progress: 100,
      new_size: tmpSize,
      final_path: final,
      trash_path: trashPath,
      finished_at: now(),
    });
  } catch (err) {
    await fail(err.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The window is [start, end) in server local time, and may wrap midnight.
// Checked only before a job is picked up: an encode already running is never
// interrupted by the window closing.
export function withinSchedule(date, settings) {
  if (!settings.scheduleEnabled) return true;
  const hour = date.getHours();
  const { scheduleStartHour: start, scheduleEndHour: end } = settings;
  return start < end
    ? hour >= start && hour < end
    : hour >= start || hour < end;
}

export function startWorker(db, deps) {
  const { idleMs = 2000, now = Date.now } = deps;
  let stopped = false;

  (async () => {
    while (!stopped) {
      try {
        // Read live rather than from the job snapshot: this is policy about when work
        // may start, so a schedule change should take effect immediately.
        if (!withinSchedule(new Date(now()), getSettings(db))) {
          await sleep(idleMs);
          continue;
        }
        const job = nextWaiting(db);
        if (!job) {
          await sleep(idleMs);
          continue;
        }
        await runJob(db, job, deps);
      } catch {
        // ponytail: runJob is documented to always resolve; this is a last-resort
        // net so a pathological rejection (e.g. the DB itself failing, here or in
        // getSettings/withinSchedule) can't crash the process or tight-loop on a
        // stuck row. Not a retry framework — just backs off like the idle case.
        await sleep(idleMs);
      }
    }
  })();

  return () => { stopped = true; };
}
