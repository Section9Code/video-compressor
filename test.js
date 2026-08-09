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
