import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveSafe } from './media.js';

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('resolveSafe', () => {
  let root, outside;

  before(() => {
    root = fs.realpathSync(tmpdir('vc-root-'));
    outside = fs.realpathSync(tmpdir('vc-outside-'));
    fs.mkdirSync(path.join(root, 'movies'));
    fs.writeFileSync(path.join(root, 'movies', 'a.mp4'), 'x');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
    fs.symlinkSync(outside, path.join(root, 'escape'));
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  test('accepts a normal relative path', () => {
    assert.equal(resolveSafe(root, 'movies/a.mp4'), path.join(root, 'movies', 'a.mp4'));
  });

  test('accepts the empty path as the root itself', () => {
    assert.equal(resolveSafe(root, ''), root);
  });

  test('rejects parent traversal', () => {
    assert.throws(() => resolveSafe(root, '../'), /escapes media root/);
  });

  test('rejects traversal buried mid-path', () => {
    assert.throws(() => resolveSafe(root, 'movies/../../'), /escapes media root/);
  });

  test('rejects an absolute path outside the root', () => {
    assert.throws(() => resolveSafe(root, outside), /escapes media root/);
  });

  test('rejects a symlink inside the root that points outside it', () => {
    assert.throws(() => resolveSafe(root, 'escape/secret.txt'), /escapes media root/);
  });

  test('rejects a path that does not exist', () => {
    assert.throws(() => resolveSafe(root, 'nope.mp4'), /no such path/);
  });

  test('the thrown error carries status 400', () => {
    try {
      resolveSafe(root, '../');
      assert.fail('should have thrown');
    } catch (err) {
      assert.equal(err.status, 400);
    }
  });
});

import { evenDown, wouldReduce, targetDims } from './media.js';

describe('evenDown', () => {
  test('rounds odd numbers down to even', () => {
    assert.equal(evenDown(1279), 1278);
    assert.equal(evenDown(1280), 1280);
    assert.equal(evenDown(1), 0);
  });
});

describe('wouldReduce', () => {
  test('is false when the shorter side already equals the target', () => {
    assert.equal(wouldReduce(1280, 720, 720), false);
  });

  test('is true when the shorter side exceeds the target', () => {
    assert.equal(wouldReduce(1920, 1080, 720), true);
  });

  test('uses the shorter side, so portrait video is judged correctly', () => {
    assert.equal(wouldReduce(720, 1280, 720), false);
    assert.equal(wouldReduce(1080, 1920, 720), true);
  });

  test('respects a raised target', () => {
    assert.equal(wouldReduce(1920, 1080, 1080), false);
    assert.equal(wouldReduce(3840, 2160, 1080), true);
  });

  test('is false for unreadable dimensions', () => {
    assert.equal(wouldReduce(undefined, undefined, 720), false);
    assert.equal(wouldReduce(NaN, 1080, 720), false);
  });
});

describe('targetDims', () => {
  test('scales landscape by height, preserving aspect ratio', () => {
    assert.deepEqual(targetDims(1920, 1080, 720), { width: 1280, height: 720 });
  });

  test('scales portrait by width, preserving aspect ratio', () => {
    assert.deepEqual(targetDims(1080, 1920, 720), { width: 720, height: 1280 });
  });

  test('rounds the computed side down to even', () => {
    assert.deepEqual(targetDims(1919, 1080, 720), { width: 1278, height: 720 });
  });

  test('handles a square source', () => {
    assert.deepEqual(targetDims(1080, 1080, 720), { width: 720, height: 720 });
  });

  test('both sides are always even', () => {
    for (const [w, h] of [[1921, 1081], [999, 1777], [3840, 2160]]) {
      const d = targetDims(w, h, 720);
      assert.equal(d.width % 2, 0, `width ${d.width} for ${w}x${h}`);
      assert.equal(d.height % 2, 0, `height ${d.height} for ${w}x${h}`);
    }
  });
});

import { VIDEO_EXTENSIONS, scanTree, listDirs } from './media.js';

describe('scanTree', () => {
  let root;

  const fakeProbe = async (file) => {
    if (file.endsWith('broken.mp4')) return null;
    if (file.endsWith('big.mkv')) return { codec: 'h264', width: 3840, height: 2160, duration: 60 };
    return { codec: 'h264', width: 1280, height: 720, duration: 30 };
  };

  before(() => {
    root = fs.realpathSync(tmpdir('vc-scan-'));
    fs.mkdirSync(path.join(root, 'nested', 'deep'), { recursive: true });
    fs.mkdirSync(path.join(root, '.trash', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(root, 'small.mp4'), 'aaaa');
    fs.writeFileSync(path.join(root, 'broken.mp4'), 'a');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'a');
    fs.writeFileSync(path.join(root, '.small.tmp.mp4'), 'a');
    fs.writeFileSync(path.join(root, 'nested', 'deep', 'big.mkv'), 'aaaaaaaa');
    fs.writeFileSync(path.join(root, '.trash', 'nested', 'old.mp4'), 'a');
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test('finds videos recursively and reports size and probe data', async () => {
    const found = await scanTree(root, { probe: fakeProbe });
    const byName = Object.fromEntries(found.map((f) => [path.basename(f.path), f]));

    assert.deepEqual(Object.keys(byName).sort(), ['big.mkv', 'broken.mp4', 'small.mp4']);
    assert.equal(byName['big.mkv'].width, 3840);
    assert.equal(byName['big.mkv'].size, 8);
    assert.equal(byName['small.mp4'].codec, 'h264');
  });

  test('ignores non-video extensions', async () => {
    const found = await scanTree(root, { probe: fakeProbe });
    assert.ok(!found.some((f) => f.path.endsWith('notes.txt')));
  });

  test('ignores the trash directory', async () => {
    const found = await scanTree(root, { probe: fakeProbe });
    assert.ok(!found.some((f) => f.path.includes('.trash')));
  });

  test('ignores in-progress temp files', async () => {
    const found = await scanTree(root, { probe: fakeProbe });
    assert.ok(!found.some((f) => path.basename(f.path).startsWith('.')));
  });

  test('keeps unprobeable files but flags them', async () => {
    const found = await scanTree(root, { probe: fakeProbe });
    const broken = found.find((f) => f.path.endsWith('broken.mp4'));
    assert.equal(broken.probeError, true);
    assert.equal(broken.width, null);
  });

  test('flags files whose probe throws rather than failing the whole scan', async () => {
    const throwingProbe = async (file) => {
      if (file.endsWith('small.mp4')) throw new Error('ffprobe exploded');
      return fakeProbe(file);
    };
    const found = await scanTree(root, { probe: throwingProbe });
    assert.equal(found.length, 3);
    assert.equal(found.find((f) => f.path.endsWith('small.mp4')).probeError, true);
  });

  test('covers every documented extension', () => {
    for (const ext of ['mkv', 'mp4', 'avi', 'mov', 'wmv', 'flv', 'm4v', 'mpg', 'mpeg', 'ts', 'm2ts', 'webm']) {
      assert.ok(VIDEO_EXTENSIONS.includes(ext), `missing ${ext}`);
    }
  });
});

describe('listDirs', () => {
  let root;

  before(() => {
    root = fs.realpathSync(tmpdir('vc-dirs-'));
    fs.mkdirSync(path.join(root, 'movies'));
    fs.mkdirSync(path.join(root, 'tv'));
    fs.mkdirSync(path.join(root, '.trash'));
    fs.writeFileSync(path.join(root, 'a.mp4'), 'x');
  });

  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test('returns immediate subdirectories, excluding trash and dotfiles', async () => {
    const dirs = await listDirs(root);
    assert.deepEqual(dirs.map((d) => path.basename(d)).sort(), ['movies', 'tv']);
  });
});

import { open, addJobs, listJobs, getJob, nextWaiting, updateJob, deleteJob, requeueJob, recoverProcessing } from './db.js';

const SAMPLE_SETTINGS = {
  targetShortSide: 720, quality: 25, encoder: 'vaapi',
  container: 'mp4', audioBitrate: '128k', vaapiDevice: '/dev/dri/renderD128',
};

const sampleFile = (p, over = {}) => ({
  path: p, width: 1920, height: 1080, codec: 'h264', size: 1000, duration: 60, ...over,
});

describe('jobs table', () => {
  test('addJobs inserts rows as waiting with a settings snapshot', () => {
    const db = open(':memory:');
    const n = addJobs(db, [sampleFile('/media/a.mp4')], SAMPLE_SETTINGS);
    assert.equal(n, 1);

    const [row] = listJobs(db);
    assert.equal(row.path, '/media/a.mp4');
    assert.equal(row.status, 'waiting');
    assert.equal(row.progress, 0);
    assert.equal(row.orig_size, 1000);
    assert.deepEqual(JSON.parse(row.settings_json), SAMPLE_SETTINGS);
    assert.ok(row.created_at > 0);
  });

  test('addJobs ignores a path that is already queued', () => {
    const db = open(':memory:');
    addJobs(db, [sampleFile('/media/a.mp4')], SAMPLE_SETTINGS);
    const n = addJobs(db, [sampleFile('/media/a.mp4'), sampleFile('/media/b.mp4')], SAMPLE_SETTINGS);
    assert.equal(n, 1);
    assert.equal(listJobs(db).length, 2);
  });

  test('a settings change does not touch already-queued jobs', () => {
    const db = open(':memory:');
    addJobs(db, [sampleFile('/media/a.mp4')], SAMPLE_SETTINGS);
    addJobs(db, [sampleFile('/media/b.mp4')], { ...SAMPLE_SETTINGS, quality: 30 });
    const [a, b] = listJobs(db);
    assert.equal(JSON.parse(a.settings_json).quality, 25);
    assert.equal(JSON.parse(b.settings_json).quality, 30);
  });

  test('nextWaiting returns the lowest waiting id and skips other statuses', () => {
    const db = open(':memory:');
    addJobs(db, [sampleFile('/media/a.mp4'), sampleFile('/media/b.mp4')], SAMPLE_SETTINGS);
    const first = nextWaiting(db);
    assert.equal(first.path, '/media/a.mp4');

    updateJob(db, first.id, { status: 'done' });
    assert.equal(nextWaiting(db).path, '/media/b.mp4');

    updateJob(db, 2, { status: 'failed' });
    assert.equal(nextWaiting(db), undefined);
  });

  test('updateJob writes whitelisted columns and ignores unknown keys', () => {
    const db = open(':memory:');
    addJobs(db, [sampleFile('/media/a.mp4')], SAMPLE_SETTINGS);
    updateJob(db, 1, { status: 'done', new_size: 400, progress: 100, nonsense: 1 });
    const row = getJob(db, 1);
    assert.equal(row.status, 'done');
    assert.equal(row.new_size, 400);
    assert.equal(row.progress, 100);
  });

  test('updateJob refuses a column name that is not whitelisted', () => {
    const db = open(':memory:');
    addJobs(db, [sampleFile('/media/a.mp4')], SAMPLE_SETTINGS);
    updateJob(db, 1, { 'path = "hacked", status': 'x' });
    assert.equal(getJob(db, 1).path, '/media/a.mp4');
  });

  test('deleteJob removes a waiting job and refuses any other status', () => {
    const db = open(':memory:');
    addJobs(db, [sampleFile('/media/a.mp4')], SAMPLE_SETTINGS);
    updateJob(db, 1, { status: 'processing' });
    assert.equal(deleteJob(db, 1), false);
    updateJob(db, 1, { status: 'waiting' });
    assert.equal(deleteJob(db, 1), true);
    assert.equal(listJobs(db).length, 0);
  });

  test('requeueJob resets failed and skipped rows and clears their result fields', () => {
    const db = open(':memory:');
    addJobs(db, [sampleFile('/media/a.mp4')], SAMPLE_SETTINGS);
    updateJob(db, 1, { status: 'failed', error: 'boom', new_size: 999, progress: 40 });

    assert.equal(requeueJob(db, 1), true);
    const row = getJob(db, 1);
    assert.equal(row.status, 'waiting');
    assert.equal(row.error, null);
    assert.equal(row.new_size, null);
    assert.equal(row.progress, 0);

    assert.equal(requeueJob(db, 1), false, 'a waiting job cannot be requeued');
  });

  test('recoverProcessing resets interrupted jobs and reports them', () => {
    const db = open(':memory:');
    addJobs(db, [sampleFile('/media/a.mp4'), sampleFile('/media/b.mp4')], SAMPLE_SETTINGS);
    updateJob(db, 1, { status: 'processing', progress: 55 });

    const recovered = recoverProcessing(db);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].path, '/media/a.mp4');

    const row = getJob(db, 1);
    assert.equal(row.status, 'waiting');
    assert.equal(row.progress, 0);
    assert.equal(recoverProcessing(db).length, 0);
  });
});

import { DEFAULT_SETTINGS, validateSettings, getSettings, putSettings } from './db.js';

describe('settings', () => {
  test('defaults match the shell script', () => {
    assert.deepEqual(DEFAULT_SETTINGS, {
      targetShortSide: 720,
      quality: 25,
      encoder: 'vaapi',
      container: 'mp4',
      audioBitrate: '128k',
      vaapiDevice: '/dev/dri/renderD128',
    });
  });

  test('getSettings returns the defaults before anything is saved', () => {
    const db = open(':memory:');
    assert.deepEqual(getSettings(db), DEFAULT_SETTINGS);
  });

  test('putSettings persists and getSettings reads back', () => {
    const db = open(':memory:');
    putSettings(db, { ...DEFAULT_SETTINGS, quality: 28, encoder: 'software' });
    assert.equal(getSettings(db).quality, 28);
    assert.equal(getSettings(db).encoder, 'software');
  });

  test('putSettings overwrites rather than accumulating rows', () => {
    const db = open(':memory:');
    putSettings(db, { ...DEFAULT_SETTINGS, quality: 28 });
    putSettings(db, { ...DEFAULT_SETTINGS, quality: 22 });
    assert.equal(getSettings(db).quality, 22);
  });

  test('a partial body is merged onto the defaults', () => {
    assert.deepEqual(validateSettings({ quality: 20 }), { ...DEFAULT_SETTINGS, quality: 20 });
  });

  test('unknown keys are stripped', () => {
    assert.deepEqual(validateSettings({ evil: true }), DEFAULT_SETTINGS);
  });

  for (const bad of [
    { targetShortSide: 999 },
    { targetShortSide: '720' },
    { quality: 17 },
    { quality: 33 },
    { quality: 25.5 },
    { encoder: 'nvenc' },
    { container: 'avi' },
    { audioBitrate: '128' },
    { audioBitrate: '128k; rm -rf /' },
    { vaapiDevice: '/etc/passwd' },
  ]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => validateSettings(bad), (err) => err.status === 400);
    });
  }

  test('accepts every allowed target and encoder', () => {
    for (const targetShortSide of [480, 540, 720, 1080, 1440]) {
      assert.equal(validateSettings({ targetShortSide }).targetShortSide, targetShortSide);
    }
    for (const encoder of ['vaapi', 'qsv', 'software']) {
      assert.equal(validateSettings({ encoder }).encoder, encoder);
    }
  });
});

import { buildEncodeArgs } from './encode.js';

describe('buildEncodeArgs', () => {
  const base = {
    src: '/media/in put.mkv',
    tmp: '/media/.in put.tmp.mp4',
    width: 1920,
    height: 1080,
    audioCodec: 'ac3',
    settings: SAMPLE_SETTINGS,
  };

  // Find the value that follows a flag, so assertions do not depend on argument order.
  const after = (args, flag) => args[args.indexOf(flag) + 1];

  test('vaapi: hardware device, scale filter and CQP quality', () => {
    const args = buildEncodeArgs(base);
    assert.equal(after(args, '-vaapi_device'), '/dev/dri/renderD128');
    assert.equal(after(args, '-vf'), 'format=nv12,hwupload,scale_vaapi=w=1280:h=720');
    assert.equal(after(args, '-c:v'), 'hevc_vaapi');
    assert.equal(after(args, '-rc_mode'), 'CQP');
    assert.equal(after(args, '-qp'), '25');
  });

  test('qsv: hardware init, vpp filter and global_quality', () => {
    const args = buildEncodeArgs({ ...base, settings: { ...SAMPLE_SETTINGS, encoder: 'qsv' } });
    assert.ok(args.includes('-init_hw_device'));
    assert.equal(after(args, '-vf'), 'format=nv12,hwupload=extra_hw_frames=64,vpp_qsv=w=1280:h=720');
    assert.equal(after(args, '-c:v'), 'hevc_qsv');
    assert.equal(after(args, '-global_quality'), '25');
  });

  test('software: plain scale, libx265 and crf', () => {
    const args = buildEncodeArgs({ ...base, settings: { ...SAMPLE_SETTINGS, encoder: 'software' } });
    assert.ok(!args.includes('-vaapi_device'));
    assert.equal(after(args, '-vf'), 'scale=1280:720');
    assert.equal(after(args, '-c:v'), 'libx265');
    assert.equal(after(args, '-crf'), '25');
  });

  test('audio is copied when the source is already aac', () => {
    const args = buildEncodeArgs({ ...base, audioCodec: 'aac' });
    assert.equal(after(args, '-c:a'), 'copy');
    assert.ok(!args.includes('-b:a'));
  });

  test('audio is transcoded to stereo aac otherwise', () => {
    const args = buildEncodeArgs(base);
    assert.equal(after(args, '-c:a'), 'aac');
    assert.equal(after(args, '-b:a'), '128k');
    assert.equal(after(args, '-ac'), '2');
  });

  test('mp4 drops subtitles, tags hvc1 and enables faststart', () => {
    const args = buildEncodeArgs(base);
    assert.ok(args.includes('-sn'));
    assert.equal(after(args, '-movflags'), '+faststart');
    assert.equal(after(args, '-tag:v'), 'hvc1');
    assert.ok(args.includes('0:a?'));
  });

  test('mkv keeps every stream and copies subtitles', () => {
    const args = buildEncodeArgs({
      ...base,
      tmp: '/media/.in put.tmp.mkv',
      settings: { ...SAMPLE_SETTINGS, container: 'mkv' },
    });
    assert.equal(after(args, '-map'), '0');
    assert.equal(after(args, '-c:s'), 'copy');
    assert.ok(!args.includes('-sn'));
  });

  test('progress reporting is enabled on stdout', () => {
    const args = buildEncodeArgs(base);
    assert.equal(after(args, '-progress'), 'pipe:1');
    assert.ok(args.includes('-nostats'));
  });

  test('portrait sources scale by width', () => {
    const args = buildEncodeArgs({ ...base, width: 1080, height: 1920 });
    assert.equal(after(args, '-vf'), 'format=nv12,hwupload,scale_vaapi=w=720:h=1280');
  });

  test('the input and output are passed as single unquoted array elements', () => {
    const args = buildEncodeArgs(base);
    assert.equal(after(args, '-i'), '/media/in put.mkv');
    assert.equal(args.at(-1), '/media/.in put.tmp.mp4');
  });
});

import { verifyEncode, DURATION_TOLERANCE } from './encode.js';

describe('verifyEncode', () => {
  const good = { exitCode: 0, tmpSize: 400, origSize: 1000, origDuration: 60, newDuration: 60 };

  test('the tolerance matches the shell script', () => {
    assert.equal(DURATION_TOLERANCE, 3);
  });

  test('passes a clean encode', () => {
    assert.deepEqual(verifyEncode(good), { status: 'done' });
  });

  test('fails on a non-zero exit code even if the output looks fine', () => {
    assert.equal(verifyEncode({ ...good, exitCode: 1 }).status, 'failed');
  });

  test('fails on an empty output file', () => {
    assert.equal(verifyEncode({ ...good, tmpSize: 0 }).status, 'failed');
  });

  test('fails when either duration is unreadable', () => {
    assert.equal(verifyEncode({ ...good, newDuration: null }).status, 'failed');
    assert.equal(verifyEncode({ ...good, origDuration: 0 }).status, 'failed');
  });

  test('tolerates a drift of exactly the tolerance in both directions', () => {
    assert.equal(verifyEncode({ ...good, newDuration: 63 }).status, 'done');
    assert.equal(verifyEncode({ ...good, newDuration: 57 }).status, 'done');
  });

  test('fails one second beyond the tolerance in both directions', () => {
    assert.equal(verifyEncode({ ...good, newDuration: 64 }).status, 'failed');
    assert.equal(verifyEncode({ ...good, newDuration: 56 }).status, 'failed');
  });

  test('skips rather than fails when the output is not smaller', () => {
    assert.equal(verifyEncode({ ...good, tmpSize: 1000 }).status, 'skipped');
    assert.equal(verifyEncode({ ...good, tmpSize: 1200 }).status, 'skipped');
  });

  test('passes when the output is smaller by a single byte', () => {
    assert.equal(verifyEncode({ ...good, tmpSize: 999 }).status, 'done');
  });

  test('every non-done result carries a reason', () => {
    for (const bad of [{ exitCode: 1 }, { tmpSize: 0 }, { newDuration: 100 }, { tmpSize: 1000 }]) {
      const result = verifyEncode({ ...good, ...bad });
      assert.ok(result.reason, `no reason for ${JSON.stringify(bad)}`);
    }
  });
});

import { createProgressParser, percentFrom, swapInPlace } from './encode.js';

describe('createProgressParser', () => {
  test('emits one block per progress marker', () => {
    const feed = createProgressParser();
    const blocks = feed('frame=10\nbitrate=1200.0kbits/s\nout_time_us=5000000\nprogress=continue\n');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].out_time_us, '5000000');
    assert.equal(blocks[0].bitrate, '1200.0kbits/s');
    assert.equal(blocks[0].progress, 'continue');
  });

  test('reassembles blocks split across chunk boundaries', () => {
    const feed = createProgressParser();
    assert.deepEqual(feed('out_time_us=500'), []);
    assert.deepEqual(feed('0000\nprog'), []);
    const blocks = feed('ress=continue\n');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].out_time_us, '5000000');
  });

  test('does not leak keys from one block into the next', () => {
    const feed = createProgressParser();
    feed('bitrate=1200.0kbits/s\nout_time_us=1000000\nprogress=continue\n');
    const [second] = feed('out_time_us=2000000\nprogress=end\n');
    assert.equal(second.bitrate, undefined);
    assert.equal(second.progress, 'end');
  });

  test('ignores lines with no equals sign', () => {
    const feed = createProgressParser();
    const blocks = feed('garbage\nout_time_us=1000000\nprogress=continue\n');
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].out_time_us, '1000000');
  });
});

describe('percentFrom', () => {
  test('converts microseconds against the duration', () => {
    assert.equal(percentFrom({ out_time_us: '30000000' }, 60), 50);
  });

  test('clamps to 100 when ffmpeg overshoots', () => {
    assert.equal(percentFrom({ out_time_us: '61000000' }, 60), 100);
  });

  test('returns null without a usable duration or timestamp', () => {
    assert.equal(percentFrom({ out_time_us: '30000000' }, 0), null);
    assert.equal(percentFrom({ out_time_us: 'N/A' }, 60), null);
    assert.equal(percentFrom({}, 60), null);
  });
});

describe('swapInPlace', () => {
  let root;

  const setup = () => {
    root = fs.realpathSync(tmpdir('vc-swap-'));
    fs.mkdirSync(path.join(root, 'movies'));
    return root;
  };

  test('moves the original into trash and the temp file into place', async () => {
    setup();
    const src = path.join(root, 'movies', 'a.mkv');
    const tmp = path.join(root, 'movies', '.a.tmp.mp4');
    const final = path.join(root, 'movies', 'a.mp4');
    fs.writeFileSync(src, 'original');
    fs.writeFileSync(tmp, 'new');

    const trashPath = await swapInPlace({ src, tmp, final, mediaRoot: root });

    assert.equal(fs.readFileSync(final, 'utf8'), 'new');
    assert.equal(fs.existsSync(src), false);
    assert.equal(fs.existsSync(tmp), false);
    assert.equal(trashPath, path.join(root, '.trash', 'movies', 'a.mkv'));
    assert.equal(fs.readFileSync(trashPath, 'utf8'), 'original');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('does not overwrite an existing file in trash', async () => {
    setup();
    const src = path.join(root, 'movies', 'a.mkv');
    fs.mkdirSync(path.join(root, '.trash', 'movies'), { recursive: true });
    fs.writeFileSync(path.join(root, '.trash', 'movies', 'a.mkv'), 'older');
    fs.writeFileSync(src, 'original');
    fs.writeFileSync(path.join(root, 'movies', '.a.tmp.mp4'), 'new');

    const trashPath = await swapInPlace({
      src,
      tmp: path.join(root, 'movies', '.a.tmp.mp4'),
      final: path.join(root, 'movies', 'a.mp4'),
      mediaRoot: root,
    });

    assert.equal(trashPath, path.join(root, '.trash', 'movies', 'a.mkv.1'));
    assert.equal(fs.readFileSync(path.join(root, '.trash', 'movies', 'a.mkv'), 'utf8'), 'older');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('restores the original when moving the temp file into place fails', async () => {
    setup();
    const src = path.join(root, 'movies', 'a.mkv');
    const tmp = path.join(root, 'movies', '.a.tmp.mp4');
    fs.writeFileSync(src, 'original');
    fs.writeFileSync(tmp, 'new');

    await assert.rejects(swapInPlace({
      src,
      tmp,
      final: path.join(root, 'movies', 'no-such-dir', 'a.mp4'),
      mediaRoot: root,
    }));

    assert.equal(fs.readFileSync(src, 'utf8'), 'original', 'original must be back in place');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('wraps the original error and names the trash path when the rollback also fails', async () => {
    setup();
    const src = path.join(root, 'movies', 'a.mkv');
    const tmp = path.join(root, 'movies', '.a.tmp.mp4');
    const trashPath = path.join(root, '.trash', 'movies', 'a.mkv');
    fs.writeFileSync(src, 'original');
    fs.writeFileSync(tmp, 'new');

    // Force only the restore move (trashPath -> src) to fail, leaving the
    // src->trash move and the doomed tmp->final move untouched.
    const realRename = fsp.rename;
    fsp.rename = (from, to) => {
      if (from === trashPath && to === src) return Promise.reject(new Error('restore blocked'));
      return realRename(from, to);
    };

    try {
      await assert.rejects(
        swapInPlace({
          src,
          tmp,
          final: path.join(root, 'movies', 'no-such-dir', 'a.mp4'),
          mediaRoot: root,
        }),
        (err) => {
          assert.match(err.message, /restore blocked/);
          assert.ok(err.message.includes(trashPath), 'error message must name the trash path');
          assert.ok(err.cause instanceof Error, 'error.cause must be the original tmp->final failure');
          assert.notEqual(err.cause.message, 'restore blocked');
          return true;
        },
      );
    } finally {
      fsp.rename = realRename;
    }

    assert.equal(fs.readFileSync(trashPath, 'utf8'), 'original', 'original is left recoverable in trash');
    fs.rmSync(root, { recursive: true, force: true });
  });
});

import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { runJob, tempPathFor } from './worker.js';

function fakeSpawn({ exitCode = 0, stdout = '', stderr = '', writesOutput = null } = {}) {
  const calls = [];
  const spawn = (bin, args) => {
    calls.push({ bin, args });
    if (writesOutput) fs.writeFileSync(args.at(-1), writesOutput);
    const child = new EventEmitter();
    child.stdout = Readable.from([stdout]);
    child.stderr = Readable.from([stderr]);
    // Attach 'end' synchronously: the stream stays paused until runFfmpeg adds its
    // own 'data' listener, so this cannot fire early. Deferring the attach with
    // setImmediate misses 'end' entirely, because Readable.from flushes on a
    // nextTick chain that drains before the check phase.
    child.stdout.on('end', () => setImmediate(() => child.emit('close', exitCode)));
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

describe('runJob', () => {
  let root;

  const prepare = (contents = 'x'.repeat(1000)) => {
    root = fs.realpathSync(tmpdir('vc-job-'));
    fs.mkdirSync(path.join(root, 'movies'));
    const src = path.join(root, 'movies', 'clip.mkv');
    fs.writeFileSync(src, contents);

    const db = open(':memory:');
    addJobs(db, [{ path: src, width: 1920, height: 1080, codec: 'h264', size: contents.length, duration: 60 }], SAMPLE_SETTINGS);
    return { db, src, job: nextWaiting(db) };
  };

  const deps = (over = {}) => ({
    mediaRoot: root,
    probeVideo: async () => ({ codec: 'hevc', width: 1280, height: 720, duration: 60 }),
    probeAudioCodec: async () => 'ac3',
    now: () => 1700000000000,
    ...over,
  });

  test('a successful encode marks the job done and trashes the original', async () => {
    const { db, src, job } = prepare();
    const spawn = fakeSpawn({ writesOutput: 'small', stdout: 'out_time_us=60000000\nprogress=end\n' });

    await runJob(db, job, deps({ spawn }));

    const row = getJob(db, job.id);
    assert.equal(row.status, 'done');
    assert.equal(row.new_size, 5);
    assert.equal(row.progress, 100);
    assert.equal(row.final_path, path.join(root, 'movies', 'clip.mp4'));
    assert.equal(row.trash_path, path.join(root, '.trash', 'movies', 'clip.mkv'));
    assert.equal(row.finished_at, 1700000000000);
    assert.equal(fs.existsSync(src), false);
    assert.equal(fs.readFileSync(row.final_path, 'utf8'), 'small');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('the encode uses the job settings snapshot, not current settings', async () => {
    const { db, job } = prepare();
    putSettings(db, { ...SAMPLE_SETTINGS, quality: 32, encoder: 'software' });
    const spawn = fakeSpawn({ writesOutput: 'small' });

    await runJob(db, job, deps({ spawn }));

    const args = spawn.calls[0].args;
    assert.ok(args.includes('hevc_vaapi'), 'snapshot said vaapi');
    assert.equal(args[args.indexOf('-qp') + 1], '25', 'snapshot said quality 25');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('progress is written to the row while encoding', async () => {
    const { db, job } = prepare();
    const spawn = fakeSpawn({
      writesOutput: 'small',
      stdout: 'bitrate=900.0kbits/s\nout_time_us=30000000\nprogress=continue\n',
    });

    await runJob(db, job, deps({ spawn, progressIntervalMs: 0 }));

    assert.equal(getJob(db, job.id).bitrate, '900.0kbits/s');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a non-zero exit marks the job failed, keeps the original and stores stderr', async () => {
    const { db, src, job } = prepare();
    const spawn = fakeSpawn({ exitCode: 1, stderr: 'Device creation failed' });

    await runJob(db, job, deps({ spawn }));

    const row = getJob(db, job.id);
    assert.equal(row.status, 'failed');
    assert.match(row.error, /Device creation failed/);
    assert.equal(fs.existsSync(src), true, 'original must survive a failure');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('an output that is not smaller marks the job skipped and deletes the temp file', async () => {
    const { db, src, job } = prepare('x'.repeat(100));
    const spawn = fakeSpawn({ writesOutput: 'y'.repeat(500) });

    await runJob(db, job, deps({ spawn }));

    const row = getJob(db, job.id);
    assert.equal(row.status, 'skipped');
    assert.match(row.error, /not smaller/);
    assert.equal(fs.existsSync(src), true);
    assert.equal(fs.existsSync(tempPathFor(src, 'mp4')), false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a duration mismatch marks the job failed and deletes the temp file', async () => {
    const { db, src, job } = prepare();
    const spawn = fakeSpawn({ writesOutput: 'small' });

    await runJob(db, job, deps({
      spawn,
      probeVideo: async () => ({ codec: 'hevc', width: 1280, height: 720, duration: 20 }),
    }));

    const row = getJob(db, job.id);
    assert.equal(row.status, 'failed');
    assert.match(row.error, /duration mismatch/);
    assert.equal(fs.existsSync(src), true);
    assert.equal(fs.existsSync(tempPathFor(src, 'mp4')), false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a source that vanished before its turn fails cleanly', async () => {
    const { db, src, job } = prepare();
    fs.unlinkSync(src);

    await runJob(db, job, deps({ spawn: fakeSpawn() }));

    assert.equal(getJob(db, job.id).status, 'failed');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a corrupted settings snapshot fails the job instead of rejecting the promise', async () => {
    const { db, src, job } = prepare();
    const corrupted = { ...job, settings_json: 'not json' };

    await assert.doesNotReject(runJob(db, corrupted, deps({ spawn: fakeSpawn() })));

    const row = getJob(db, job.id);
    assert.equal(row.status, 'failed');
    assert.equal(fs.existsSync(src), true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('tempPathFor', () => {
  test('hides the temp file and gives it the target extension', () => {
    assert.equal(tempPathFor('/media/movies/a b.mkv', 'mp4'), '/media/movies/.a b.tmp.mp4');
  });
});
