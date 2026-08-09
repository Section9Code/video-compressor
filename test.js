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
