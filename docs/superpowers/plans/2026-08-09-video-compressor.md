# Video Compressor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A self-hosted web app that queues server-side video files and re-encodes them to a lower resolution with HEVC using Intel hardware acceleration, replacing `docs/videosCompress.sh`.

**Architecture:** One Node process serves an Express JSON API plus static Alpine.js frontend, and runs a single-job encode worker as an async loop in the same process. State lives in SQLite via `node:sqlite`. All the logic that can be silently wrong — path safety, dimension maths, ffmpeg argument construction, the verify predicate, progress parsing, the trash swap — is factored into pure or filesystem-only functions that are unit tested without ffmpeg being installed.

**Tech Stack:** Node 24, Express 5, `node:sqlite`, `node:test`, Alpine.js 3, Tailwind CSS v4, ffmpeg/ffprobe (VAAPI/QSV/libx265), Docker.

**Spec:** `docs/superpowers/specs/2026-08-09-video-compressor-design.md`

## Global Constraints

- Node 24 with ESM: `package.json` has `"type": "module"`. All files use `import`, not `require`.
- Exactly one runtime dependency: `express`. Build-time only: `@tailwindcss/cli`, `alpinejs`. Everything else is Node stdlib. **Do not add any other dependency** — no supertest, no better-sqlite3, no nodemon, no dotenv.
- Tests use `node:test` and `node:assert/strict` only. All tests live in one file, `test.js`, at the repo root, grouped with `describe`. `npm test` runs `node --test`.
- Tests must pass on a machine with **no ffmpeg installed**. Anything that shells out to ffmpeg/ffprobe is injected as a dependency and stubbed in tests.
- No client-supplied path is ever used to touch the filesystem without passing through `resolveSafe`.
- ffmpeg is always invoked via `spawn` with an argument **array**. Never a shell string, never string interpolation of filenames.
- Encode behaviour must match `docs/videosCompress.sh`: HEVC, QP/CRF default `25`, target short side default `720`, audio copied when already AAC otherwise AAC at `128k` stereo, mp4 mapping `-map 0:v:0 -map 0:a? -sn -movflags +faststart -tag:v hvc1`, mkv mapping `-map 0 -c:s copy`, duration tolerance `3` seconds, output must be strictly smaller than the original.
- Default settings, verbatim: `targetShortSide: 720`, `quality: 25`, `encoder: "vaapi"`, `container: "mp4"`, `audioBitrate: "128k"`, `vaapiDevice: "/dev/dri/renderD128"`. Task 16 adds `scheduleEnabled: false`, `scheduleStartHour: 2`, `scheduleEndHour: 6`.
- Job statuses, verbatim: `waiting`, `processing`, `done`, `skipped`, `failed`.
- Env vars: `MEDIA_ROOT` (default `/media`), `DB_PATH` (default `/data/queue.db`), `PORT` (default `3000`), `TZ` (default UTC; only affects the encode schedule window).
- Every path crossing the HTTP boundary, in either direction, is relative to `MEDIA_ROOT`. Absolute paths never leave the server.
- Frontend styling follows `docs/design/design.md` ("Cybernetic Core"): zero border radius, translucent surfaces with `backdrop-blur`, 1px neon borders with glow for elevation, JetBrains Mono for every path/size/status readout, Inter for UI text, `[ BRACKETED ]` status pills.
- Commit after every task. Conventional commit prefixes (`feat:`, `test:`, `chore:`, `fix:`).

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | ESM, scripts, the three dependencies |
| `media.js` | Path safety, dimension maths, ffprobe wrapper, recursive scan |
| `db.js` | SQLite schema, job queries, settings store and validation, restart recovery |
| `encode.js` | Pure encode logic: argument builder, verify predicate, progress parser, trash swap |
| `worker.js` | The async loop that drives `encode.js` against the DB |
| `server.js` | Express app factory, routes, error middleware, entrypoint |
| `src/app.css` | Tailwind v4 `@theme` tokens (source) |
| `public/index.html` | Alpine markup for both views and the settings panel |
| `public/app.js` | The Alpine component |
| `test.js` | Every test |
| `Dockerfile`, `docker-compose.yml`, `.env.example`, `README.md` | Deployment |

Generated, gitignored: `public/app.css`, `public/alpine.js`, `node_modules/`.

---

### Task 1: Scaffold and path safety

**Files:**
- Create: `package.json`
- Create: `media.js`
- Create: `test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `badRequest(message) -> Error` with `.status = 400`; `resolveSafe(root, rel) -> string` (absolute, real, guaranteed inside `root`; throws a 400 Error otherwise).

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "video-compressor",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "test": "node --test",
    "css": "tailwindcss -i src/app.css -o public/app.css --minify",
    "build": "npm run css && cp node_modules/alpinejs/dist/cdn.min.js public/alpine.js"
  },
  "dependencies": {
    "express": "^5.1.0"
  },
  "devDependencies": {
    "@tailwindcss/cli": "^4.1.0",
    "alpinejs": "^3.14.0"
  }
}
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: `node_modules/` created, no errors. `npm ls express` shows express 5.x.

- [ ] **Step 3: Write the failing tests**

Create `test.js`:

```js
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
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './media.js'`.

- [ ] **Step 5: Write the minimal implementation**

Create `media.js`:

```js
import fs from 'node:fs';
import path from 'node:path';

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
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, 8 tests.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json media.js test.js
git commit -m "feat: scaffold project and add path-safety guard"
```

---

### Task 2: Dimension maths

**Files:**
- Modify: `media.js`
- Modify: `test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `evenDown(n) -> number`; `wouldReduce(width, height, targetShortSide) -> boolean`; `targetDims(width, height, targetShortSide) -> {width, height}`.

- [ ] **Step 1: Write the failing tests**

Append to `test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `evenDown is not a function` (or a SyntaxError about the missing export).

- [ ] **Step 3: Write the minimal implementation**

Append to `media.js`:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add media.js test.js
git commit -m "feat: add resolution filter and target dimension maths"
```

---

### Task 3: ffprobe wrapper and recursive scan

**Files:**
- Modify: `media.js`
- Modify: `test.js`

**Interfaces:**
- Consumes: `resolveSafe` (not used here, but same module).
- Produces:
  - `VIDEO_EXTENSIONS: string[]`
  - `probeVideo(file) -> Promise<{codec, width, height, duration} | null>` — `null` when there is no readable video stream.
  - `probeAudioCodec(file) -> Promise<string|null>`
  - `scanTree(absDir, { probe, concurrency }) -> Promise<Array<{path, size, codec, width, height, duration, probeError}>>` — `path` is absolute; `probe` defaults to `probeVideo` and is injected by tests.
  - `listDirs(absDir) -> Promise<string[]>` — absolute paths of immediate subdirectories.

- [ ] **Step 1: Write the failing tests**

Append to `test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `scanTree is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `media.js`:

```js
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import { promisify } from 'node:util';

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
  const entries = await fsp.readdir(dir, { withFileTypes: true });
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

  return pool(files, concurrency, async (file) => {
    const size = (await fsp.stat(file)).size;
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
}
```

Note: `import` statements must sit at the top of the file — move the three new
imports up alongside the existing `fs`/`path` imports rather than leaving them
mid-file.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add media.js test.js
git commit -m "feat: add ffprobe wrapper and recursive video scan"
```

---

### Task 4: Database schema, job queries and restart recovery

**Files:**
- Create: `db.js`
- Modify: `test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `open(file) -> DatabaseSync` — applies the schema.
  - `addJobs(db, files, settings) -> number` — `files` are `{path, width, height, codec, size, duration}`; returns how many rows were newly inserted. Duplicate paths are ignored.
  - `listJobs(db) -> row[]` ordered by `id`.
  - `getJob(db, id) -> row | undefined`
  - `nextWaiting(db) -> row | undefined` — lowest `id` with status `waiting`.
  - `updateJob(db, id, fields)` — whitelisted columns only.
  - `deleteJob(db, id) -> boolean` — only when `waiting`.
  - `requeueJob(db, id) -> boolean` — only when `failed` or `skipped`.
  - `recoverProcessing(db) -> row[]` — the rows it reset.

- [ ] **Step 1: Write the failing tests**

Append to `test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './db.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `db.js`:

```js
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id            INTEGER PRIMARY KEY,
  path          TEXT    NOT NULL UNIQUE,
  status        TEXT    NOT NULL,
  width         INTEGER,
  height        INTEGER,
  codec         TEXT,
  orig_size     INTEGER,
  new_size      INTEGER,
  duration      REAL,
  progress      INTEGER NOT NULL DEFAULT 0,
  bitrate       TEXT,
  final_path    TEXT,
  trash_path    TEXT,
  settings_json TEXT    NOT NULL,
  error         TEXT,
  created_at    INTEGER NOT NULL,
  finished_at   INTEGER
);

CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, id);

CREATE TABLE IF NOT EXISTS settings (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL
);
`;

// Only these columns may be written by updateJob. The whitelist is what keeps a
// caller-supplied key out of the generated SQL.
const WRITABLE = new Set([
  'status', 'new_size', 'progress', 'bitrate',
  'final_path', 'trash_path', 'error', 'finished_at',
]);

export function open(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

export function addJobs(db, files, settings) {
  const snapshot = JSON.stringify(settings);
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO jobs
      (path, status, width, height, codec, orig_size, duration, settings_json, created_at)
    VALUES (?, 'waiting', ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  for (const f of files) {
    const res = stmt.run(f.path, f.width ?? null, f.height ?? null, f.codec ?? null,
      f.size ?? null, f.duration ?? null, snapshot, now);
    inserted += res.changes;
  }
  return inserted;
}

export function listJobs(db) {
  return db.prepare('SELECT * FROM jobs ORDER BY id').all();
}

export function getJob(db, id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
}

export function nextWaiting(db) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'waiting' ORDER BY id LIMIT 1").get();
}

export function updateJob(db, id, fields) {
  const keys = Object.keys(fields).filter((k) => WRITABLE.has(k));
  if (keys.length === 0) return;
  const sql = `UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  db.prepare(sql).run(...keys.map((k) => fields[k]), id);
}

export function deleteJob(db, id) {
  const res = db.prepare("DELETE FROM jobs WHERE id = ? AND status = 'waiting'").run(id);
  return res.changes > 0;
}

export function requeueJob(db, id) {
  const res = db.prepare(`
    UPDATE jobs
       SET status = 'waiting', error = NULL, new_size = NULL, progress = 0,
           bitrate = NULL, finished_at = NULL
     WHERE id = ? AND status IN ('failed', 'skipped')
  `).run(id);
  return res.changes > 0;
}

// An encode killed mid-write leaves only a temp file, so the source is always intact
// and the job is safe to retry from scratch. The caller deletes the temp files.
export function recoverProcessing(db) {
  const rows = db.prepare("SELECT * FROM jobs WHERE status = 'processing'").all();
  db.exec("UPDATE jobs SET status = 'waiting', progress = 0, bitrate = NULL WHERE status = 'processing'");
  return rows;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS. Node may print `ExperimentalWarning: SQLite is an experimental feature` — that is fine.

- [ ] **Step 5: Commit**

```bash
git add db.js test.js
git commit -m "feat: add sqlite job store with restart recovery"
```

---

### Task 5: Settings store and validation

**Files:**
- Modify: `db.js`
- Modify: `test.js`

**Interfaces:**
- Consumes: `badRequest` from `media.js`, `open` from `db.js`.
- Produces:
  - `DEFAULT_SETTINGS`, `TARGETS`, `ENCODERS`, `CONTAINERS`
  - `validateSettings(input) -> settings` — throws a 400 Error; returns only known keys.
  - `getSettings(db) -> settings` — defaults when unset.
  - `putSettings(db, input) -> settings` — validates then persists.

- [ ] **Step 1: Write the failing tests**

Append to `test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `validateSettings is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `db.js` (and add `import { badRequest } from './media.js';` at the top):

```js
export const DEFAULT_SETTINGS = {
  targetShortSide: 720,
  quality: 25,
  encoder: 'vaapi',
  container: 'mp4',
  audioBitrate: '128k',
  vaapiDevice: '/dev/dri/renderD128',
};

export const TARGETS = [480, 540, 720, 1080, 1440];
export const ENCODERS = ['vaapi', 'qsv', 'software'];
export const CONTAINERS = ['mp4', 'mkv'];

// This is a trust boundary: every value here ends up in an ffmpeg argument list.
export function validateSettings(input) {
  const s = { ...DEFAULT_SETTINGS, ...(input ?? {}) };

  if (!TARGETS.includes(s.targetShortSide)) {
    throw badRequest(`targetShortSide must be one of ${TARGETS.join(', ')}`);
  }
  if (!Number.isInteger(s.quality) || s.quality < 18 || s.quality > 32) {
    throw badRequest('quality must be an integer between 18 and 32');
  }
  if (!ENCODERS.includes(s.encoder)) {
    throw badRequest(`encoder must be one of ${ENCODERS.join(', ')}`);
  }
  if (!CONTAINERS.includes(s.container)) {
    throw badRequest(`container must be one of ${CONTAINERS.join(', ')}`);
  }
  if (typeof s.audioBitrate !== 'string' || !/^\d{1,4}k$/.test(s.audioBitrate)) {
    throw badRequest('audioBitrate must look like "128k"');
  }
  if (typeof s.vaapiDevice !== 'string' || !/^\/dev\/dri\/[A-Za-z0-9]+$/.test(s.vaapiDevice)) {
    throw badRequest('vaapiDevice must be a /dev/dri device path');
  }

  return {
    targetShortSide: s.targetShortSide,
    quality: s.quality,
    encoder: s.encoder,
    container: s.container,
    audioBitrate: s.audioBitrate,
    vaapiDevice: s.vaapiDevice,
  };
}

export function getSettings(db) {
  const row = db.prepare('SELECT json FROM settings WHERE id = 1').get();
  if (!row) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...JSON.parse(row.json) };
}

export function putSettings(db, input) {
  const settings = validateSettings(input);
  db.prepare(`
    INSERT INTO settings (id, json) VALUES (1, ?)
    ON CONFLICT (id) DO UPDATE SET json = excluded.json
  `).run(JSON.stringify(settings));
  return settings;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add db.js test.js
git commit -m "feat: add validated settings store"
```

---

### Task 6: ffmpeg argument builder

**Files:**
- Create: `encode.js`
- Modify: `test.js`

**Interfaces:**
- Consumes: `targetDims` from `media.js`.
- Produces: `buildEncodeArgs({ src, tmp, settings, width, height, audioCodec }) -> string[]` — the full argv after the `ffmpeg` binary name.

- [ ] **Step 1: Write the failing tests**

Append to `test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './encode.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `encode.js`:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add encode.js test.js
git commit -m "feat: add ffmpeg argument builder for vaapi, qsv and software"
```

---

### Task 7: The verify predicate

**Files:**
- Modify: `encode.js`
- Modify: `test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `DURATION_TOLERANCE = 3`; `verifyEncode({ exitCode, tmpSize, origSize, origDuration, newDuration }) -> { status: 'done' } | { status: 'skipped', reason } | { status: 'failed', reason }`.

- [ ] **Step 1: Write the failing tests**

Append to `test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `verifyEncode is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `encode.js`:

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add encode.js test.js
git commit -m "feat: add encode verification predicate"
```

---

### Task 8: Progress parser and the trash swap

**Files:**
- Modify: `encode.js`
- Modify: `test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `createProgressParser() -> feed(chunk: string) -> Array<Record<string,string>>` — each returned object is one complete `-progress` block.
  - `percentFrom(block, durationSeconds) -> number|null` — 0–100, clamped.
  - `swapInPlace({ src, tmp, final, mediaRoot }) -> Promise<string>` — returns the trash path.

- [ ] **Step 1: Write the failing tests**

Append to `test.js`:

```js
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
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `createProgressParser is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `encode.js` (add `import fsp from 'node:fs/promises';` and `import path from 'node:path';` to the top of the file):

```js
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add encode.js test.js
git commit -m "feat: add progress parser and reversible trash swap"
```

---

### Task 9: The worker loop

**Files:**
- Create: `worker.js`
- Modify: `test.js`

**Interfaces:**
- Consumes: everything from `db.js`, `encode.js`, `media.js`.
- Produces:
  - `runJob(db, job, deps) -> Promise<void>` — deps are `{ mediaRoot, spawn, probeVideo, probeAudioCodec, now }`, all injectable.
  - `startWorker(db, deps) -> stop()` — deps additionally take `{ idleMs }`.
  - `cleanupTempFiles(rows)` — deletes the temp file for each recovered row.

**Note on testing:** `runJob` is tested with a fake `spawn` that returns a stub child
process, so no ffmpeg is required. The fake writes progress lines to `stdout`, an
error tail to `stderr`, and then emits `close`.

- [ ] **Step 1: Write the failing tests**

Append to `test.js`:

```js
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
    setImmediate(() => {
      child.stdout.on('end', () => setImmediate(() => child.emit('close', exitCode)));
    });
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
});

describe('tempPathFor', () => {
  test('hides the temp file and gives it the target extension', () => {
    assert.equal(tempPathFor('/media/movies/a b.mkv', 'mp4'), '/media/movies/.a b.tmp.mp4');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './worker.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `worker.js`:

```js
import { spawn as nodeSpawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { nextWaiting, updateJob } from './db.js';
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

  const settings = JSON.parse(job.settings_json);
  const tmp = tempPathFor(job.path, settings.container);
  const final = finalPathFor(job.path, settings.container);

  updateJob(db, job.id, { status: 'processing', progress: 0, bitrate: null, error: null });

  const fail = async (reason) => {
    await unlinkQuietly(tmp);
    updateJob(db, job.id, { status: 'failed', error: reason, finished_at: now() });
  };

  try {
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

export function startWorker(db, deps) {
  const { idleMs = 2000 } = deps;
  let stopped = false;

  (async () => {
    while (!stopped) {
      const job = nextWaiting(db);
      if (!job) {
        await sleep(idleMs);
        continue;
      }
      await runJob(db, job, deps);
    }
  })();

  return () => { stopped = true; };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker.js test.js
git commit -m "feat: add single-job encode worker"
```

---

### Task 10: Express API

**Files:**
- Create: `server.js`
- Modify: `test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: `createApp({ db, mediaRoot, scan, probe }) -> express.Application`. `scan` defaults to `scanTree` and `probe` to `probeVideo`; both are injected by tests so the suite never needs ffprobe.

**Response shapes:**

```js
// GET /api/browse?path=movies
{ path: 'movies', dirs: [{ path: 'movies/action', name: 'action' }] }

// GET /api/scan?path=movies
{ path: 'movies', files: [{ path: 'movies/a.mkv', name: 'a.mkv', size: 1000,
    width: 1920, height: 1080, codec: 'h264', duration: 60,
    wouldReduce: true, probeError: false, queued: false }] }

// GET /api/jobs   -> { jobs: [ ...rows with `path` and `final_path` made relative... ] }
// POST /api/jobs  -> { added: 2 }
```

- [ ] **Step 1: Write the failing tests**

Append to `test.js`:

```js
import { createApp } from './server.js';

describe('http api', () => {
  let root, db, server, base;

  const files = () => [
    { path: path.join(root, 'movies', 'big.mkv'), size: 4000, codec: 'h264', width: 1920, height: 1080, duration: 60, probeError: false },
    { path: path.join(root, 'movies', 'small.mp4'), size: 100, codec: 'h264', width: 1280, height: 720, duration: 30, probeError: false },
  ];

  before(async () => {
    root = fs.realpathSync(tmpdir('vc-api-'));
    fs.mkdirSync(path.join(root, 'movies', 'action'), { recursive: true });
    fs.writeFileSync(path.join(root, 'movies', 'big.mkv'), 'x'.repeat(4000));
    fs.writeFileSync(path.join(root, 'movies', 'small.mp4'), 'x'.repeat(100));

    db = open(':memory:');
    const app = createApp({
      db,
      mediaRoot: root,
      scan: async () => files(),
      probe: async () => ({ codec: 'h264', width: 1920, height: 1080, duration: 60 }),
    });
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const get = async (url) => {
    const res = await fetch(base + url);
    return { status: res.status, body: await res.json() };
  };

  const send = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  test('browse lists subdirectories as relative paths', async () => {
    const { status, body } = await get('/api/browse?path=movies');
    assert.equal(status, 200);
    assert.deepEqual(body.dirs, [{ path: 'movies/action', name: 'action' }]);
  });

  test('browse defaults to the media root', async () => {
    const { body } = await get('/api/browse');
    assert.deepEqual(body.dirs.map((d) => d.name), ['movies']);
  });

  test('browse rejects traversal with 400', async () => {
    const { status, body } = await get('/api/browse?path=../');
    assert.equal(status, 400);
    assert.match(body.error, /escapes media root/);
  });

  test('scan returns relative paths and flags what would shrink', async () => {
    const { body } = await get('/api/scan?path=movies');
    assert.deepEqual(body.files.map((f) => f.path), ['movies/big.mkv', 'movies/small.mp4']);
    assert.equal(body.files[0].wouldReduce, true);
    assert.equal(body.files[1].wouldReduce, false);
    assert.equal(body.files[0].queued, false);
  });

  test('posting jobs enqueues them and scan then reports them as queued', async () => {
    const added = await send('POST', '/api/jobs', { paths: ['movies/big.mkv'] });
    assert.equal(added.status, 200);
    assert.equal(added.body.added, 1);

    const { body } = await get('/api/scan?path=movies');
    assert.equal(body.files.find((f) => f.path === 'movies/big.mkv').queued, true);
  });

  test('jobs are returned with relative paths', async () => {
    const { body } = await get('/api/jobs');
    assert.equal(body.jobs.length, 1);
    assert.equal(body.jobs[0].path, 'movies/big.mkv');
    assert.equal(body.jobs[0].status, 'waiting');
    assert.deepEqual(body.jobs[0].settings, DEFAULT_SETTINGS);
  });

  test('posting a path outside the root is rejected and enqueues nothing', async () => {
    const { status } = await send('POST', '/api/jobs', { paths: ['../etc/passwd'] });
    assert.equal(status, 400);
    const { body } = await get('/api/jobs');
    assert.equal(body.jobs.length, 1);
  });

  test('posting a non-array body is rejected', async () => {
    assert.equal((await send('POST', '/api/jobs', { paths: 'movies/big.mkv' })).status, 400);
  });

  test('settings round-trip and reject bad values', async () => {
    assert.deepEqual((await get('/api/settings')).body, DEFAULT_SETTINGS);
    const put = await send('PUT', '/api/settings', { ...DEFAULT_SETTINGS, quality: 28 });
    assert.equal(put.status, 200);
    assert.equal(put.body.quality, 28);
    assert.equal((await get('/api/settings')).body.quality, 28);
    assert.equal((await send('PUT', '/api/settings', { quality: 99 })).status, 400);
  });

  test('a waiting job can be deleted, a processing one cannot', async () => {
    const { body } = await get('/api/jobs');
    const id = body.jobs[0].id;

    updateJob(db, id, { status: 'processing' });
    assert.equal((await send('DELETE', `/api/jobs/${id}`)).status, 409);

    updateJob(db, id, { status: 'waiting' });
    assert.equal((await send('DELETE', `/api/jobs/${id}`)).status, 200);
    assert.equal((await get('/api/jobs')).body.jobs.length, 0);
  });

  test('a failed job can be requeued, a done one cannot', async () => {
    await send('POST', '/api/jobs', { paths: ['movies/small.mp4'] });
    const id = (await get('/api/jobs')).body.jobs[0].id;

    updateJob(db, id, { status: 'failed', error: 'boom' });
    assert.equal((await send('POST', `/api/jobs/${id}/requeue`)).status, 200);
    assert.equal((await get('/api/jobs')).body.jobs[0].status, 'waiting');

    updateJob(db, id, { status: 'done' });
    assert.equal((await send('POST', `/api/jobs/${id}/requeue`)).status, 409);
  });

  test('an unknown job id is a 404', async () => {
    assert.equal((await send('DELETE', '/api/jobs/9999')).status, 404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `Cannot find module './server.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `server.js`:

```js
import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addJobs, deleteJob, getJob, getSettings, listJobs, open,
  putSettings, recoverProcessing, requeueJob,
} from './db.js';
import { cleanupTempFiles, startWorker } from './worker.js';
import { badRequest, listDirs, probeVideo, resolveSafe, scanTree, wouldReduce } from './media.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ db, mediaRoot, scan = scanTree, probe = probeVideo }) {
  const app = express();
  app.use(express.json());

  const rel = (abs) => (abs == null ? null : path.relative(mediaRoot, abs));

  // Express 5 forwards a rejected promise to the error handler automatically.
  app.get('/api/browse', async (req, res) => {
    const abs = resolveSafe(mediaRoot, req.query.path ?? '');
    const dirs = await listDirs(abs);
    res.json({
      path: rel(abs),
      dirs: dirs.map((d) => ({ path: rel(d), name: path.basename(d) })),
    });
  });

  app.get('/api/scan', async (req, res) => {
    const abs = resolveSafe(mediaRoot, req.query.path ?? '');
    const settings = getSettings(db);
    const queued = new Set(listJobs(db).map((j) => j.path));
    const found = await scan(abs, { probe });

    res.json({
      path: rel(abs),
      files: found.map((f) => ({
        path: rel(f.path),
        name: path.basename(f.path),
        size: f.size,
        width: f.width,
        height: f.height,
        codec: f.codec,
        duration: f.duration,
        probeError: f.probeError,
        wouldReduce: wouldReduce(f.width, f.height, settings.targetShortSide),
        queued: queued.has(f.path),
      })),
    });
  });

  app.post('/api/jobs', async (req, res) => {
    const paths = req.body?.paths;
    if (!Array.isArray(paths)) {
      return res.status(400).json({ error: 'paths must be an array' });
    }

    // Resolve and probe everything before inserting anything: a bad path in the
    // list should reject the whole request rather than half-queue it.
    const files = [];
    for (const p of paths) {
      const abs = resolveSafe(mediaRoot, p);
      const info = await probe(abs).catch(() => null);
      if (!info) throw badRequest(`no readable video stream: ${p}`);
      const { size } = await fsp.stat(abs);
      files.push({ path: abs, size, ...info });
    }
    res.json({ added: addJobs(db, files, getSettings(db)) });
  });

  app.get('/api/jobs', (req, res) => {
    res.json({
      jobs: listJobs(db).map((job) => ({
        ...job,
        path: rel(job.path),
        name: path.basename(job.path),
        final_path: rel(job.final_path),
        trash_path: rel(job.trash_path),
        settings: JSON.parse(job.settings_json),
      })),
    });
  });

  app.delete('/api/jobs/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!getJob(db, id)) return res.status(404).json({ error: 'no such job' });
    if (!deleteJob(db, id)) return res.status(409).json({ error: 'only a waiting job can be removed' });
    res.json({ ok: true });
  });

  app.post('/api/jobs/:id/requeue', (req, res) => {
    const id = Number(req.params.id);
    if (!getJob(db, id)) return res.status(404).json({ error: 'no such job' });
    if (!requeueJob(db, id)) return res.status(409).json({ error: 'only a failed or skipped job can be requeued' });
    res.json({ ok: true });
  });

  app.get('/api/settings', (req, res) => res.json(getSettings(db)));
  app.put('/api/settings', (req, res) => res.json(putSettings(db, req.body)));

  app.use(express.static(path.join(HERE, 'public')));

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(err.status ?? 500).json({ error: err.message });
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mediaRoot = process.env.MEDIA_ROOT ?? '/media';
  const db = open(process.env.DB_PATH ?? '/data/queue.db');
  const port = Number(process.env.PORT ?? 3000);

  const recovered = recoverProcessing(db);
  if (recovered.length) {
    console.log(`recovered ${recovered.length} interrupted job(s)`);
    await cleanupTempFiles(recovered);
  }

  startWorker(db, { mediaRoot });
  createApp({ db, mediaRoot }).listen(port, () => {
    console.log(`video-compressor on :${port}, media root ${mediaRoot}`);
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Manually smoke-test against a real directory**

```bash
mkdir -p /tmp/vc-media/movies /tmp/vc-data
MEDIA_ROOT=/tmp/vc-media DB_PATH=/tmp/vc-data/queue.db PORT=3000 node server.js &
curl -s localhost:3000/api/browse | head
curl -s localhost:3000/api/settings
curl -s 'localhost:3000/api/browse?path=../..'
kill %1
```

Expected: `browse` lists `movies`; `settings` returns the defaults; the traversal
attempt returns `{"error":"path escapes media root: ../.."}` with status 400.

- [ ] **Step 6: Commit**

```bash
git add server.js test.js
git commit -m "feat: add express api for browsing, queueing and settings"
```

---

### Task 11: Tailwind theme and build

**Files:**
- Create: `src/app.css`
- Modify: `package.json` (only if the `css` script needs the `npx` prefix)

**Interfaces:**
- Consumes: the token table in `docs/design/design.md`.
- Produces: `public/app.css`, and the utility class names the next three tasks use — `bg-surface`, `bg-surface-container`, `bg-surface-container-high`, `text-on-surface`, `text-on-surface-variant`, `text-accent`, `bg-accent`, `text-magenta`, `text-toxic`, `text-error`, `border-outline`, `border-outline-variant`, `font-mono`, `font-sans`, and the `.glow`, `.panel`, `.pill` component classes.

- [ ] **Step 1: Write the theme**

Create `src/app.css`:

```css
@import "tailwindcss";

/* Cybernetic Core — tokens lifted from docs/design/design.md.
   Note the palette's `primary` (#e1fdff) is the near-white on-glass text colour;
   the neon cyan the mockups actually accent with is `primary-container` (#00f2ff).
   It is exposed here as `accent` so the intent is unambiguous at call sites. */
@theme {
  --color-surface: #131315;
  --color-surface-dim: #0e0e10;
  --color-surface-container-lowest: #0e0e10;
  --color-surface-container-low: #1c1b1d;
  --color-surface-container: #201f21;
  --color-surface-container-high: #2a2a2c;
  --color-surface-container-highest: #353437;

  --color-on-surface: #e5e1e4;
  --color-on-surface-variant: #b9cacb;

  --color-outline: #849495;
  --color-outline-variant: #3a494b;

  --color-accent: #00f2ff;
  --color-accent-dim: #00dbe7;
  --color-on-accent: #00363a;

  --color-magenta: #ff24e4;
  --color-magenta-soft: #fface8;

  --color-toxic: #34fc0d;
  --color-toxic-soft: #79ff5b;

  --color-error: #ffb4ab;
  --color-error-container: #93000a;

  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, "SF Mono", monospace;

  --radius-none: 0px;
}

/* Sharp corners everywhere: the design system sets roundedness to 0px. */
* {
  border-radius: 0 !important;
}

body {
  background: var(--color-surface-dim);
  color: var(--color-on-surface);
  font-family: var(--font-sans);
}

/* Depth comes from backlight and transparency, not shadow. */
@utility panel {
  background: color-mix(in srgb, var(--color-surface-container) 70%, transparent);
  backdrop-filter: blur(12px);
  border: 1px solid var(--color-outline-variant);
}

@utility glow {
  border-color: var(--color-accent);
  box-shadow: 0 0 15px color-mix(in srgb, var(--color-accent) 30%, transparent);
}

@utility pill {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.1em;
  padding: 2px 8px;
  border: 1px solid currentColor;
}

/* Segmented "data stream" progress bar. The width of .bar-fill is set inline. */
@utility bar {
  height: 28px;
  border: 1px solid var(--color-outline-variant);
  background: repeating-linear-gradient(
    90deg,
    var(--color-surface-container-high) 0 18px,
    transparent 18px 22px
  );
}
```

- [ ] **Step 2: Build the stylesheet**

Run: `npm run build`
Expected: `public/app.css` and `public/alpine.js` both exist and are non-empty.

If `npm run css` fails with "tailwindcss: not found", change the script to
`npx @tailwindcss/cli -i src/app.css -o public/app.css --minify`.

- [ ] **Step 3: Verify the tokens made it through**

Run: `grep -c 'text-accent\|--color-accent' public/app.css`
Expected: at least 1. (Tailwind v4 emits the `@theme` variables into `:root`.)

- [ ] **Step 4: Commit**

```bash
git add src/app.css package.json
git commit -m "feat: add Cybernetic Core Tailwind theme"
```

---

### Task 12: App shell and the browse view

**Files:**
- Create: `public/index.html`
- Create: `public/app.js`

**Interfaces:**
- Consumes: `GET /api/browse`, `GET /api/scan`, `POST /api/jobs`, `GET /api/settings`.
- Produces: the Alpine component `app()` with state `view`, `tree`, `scanPath`, `files`, `selected`, `jobs`, `settings`, and methods `openDir`, `scanDir`, `toggle`, `selectAllReducible`, `addSelected`.

- [ ] **Step 1: Write the markup**

Create `public/index.html`. This is the full file — both views are declared here, but
the queue view's body is filled in by Task 13.

```html
<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VIDEO_COMPRESSOR</title>
<link rel="stylesheet" href="/app.css">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700;800&family=JetBrains+Mono:wght@500;700&display=swap">
<script defer src="/alpine.js"></script>
</head>
<body class="min-h-screen" x-data="app()" x-init="boot()">

<div class="flex min-h-screen">

  <!-- SIDEBAR -->
  <aside class="w-[280px] shrink-0 border-r border-outline-variant bg-surface-container-lowest p-6 flex flex-col">
    <h1 class="font-mono text-lg font-bold tracking-[0.1em] text-accent">VIDEO_<wbr>COMPRESSOR</h1>
    <p class="mt-1 font-mono text-xs tracking-[0.1em] text-on-surface-variant">[ HEVC_PIPELINE ]</p>

    <nav class="mt-10 flex flex-col gap-1">
      <button @click="view = 'browse'" class="px-4 py-3 text-left font-mono text-sm tracking-[0.05em] border-l-2"
              :class="view === 'browse' ? 'border-accent text-accent bg-surface-container' : 'border-transparent text-on-surface-variant hover:text-on-surface'">
        FILE_TERMINAL
      </button>
      <button @click="view = 'queue'" class="px-4 py-3 text-left font-mono text-sm tracking-[0.05em] border-l-2"
              :class="view === 'queue' ? 'border-accent text-accent bg-surface-container' : 'border-transparent text-on-surface-variant hover:text-on-surface'">
        DATA_PROCESSOR
        <span x-show="activeCount" class="ml-2 pill text-toxic" x-text="activeCount"></span>
      </button>
    </nav>

    <div class="mt-auto">
      <button @click="settingsOpen = true"
              class="w-full border border-accent px-4 py-3 font-mono text-sm tracking-[0.1em] text-accent hover:glow">
        ENCODE_PARAMS
      </button>
      <p class="mt-4 font-mono text-xs text-outline" x-text="`ENCODER: ${settings.encoder?.toUpperCase() ?? '...'}`"></p>
      <p class="font-mono text-xs text-outline" x-text="`TARGET: ${settings.targetShortSide ?? '...'}P / QP ${settings.quality ?? '..'}`"></p>
    </div>
  </aside>

  <!-- MAIN -->
  <main class="flex-1 min-w-0">

    <!-- ================= BROWSE ================= -->
    <section x-show="view === 'browse'" class="flex h-screen">

      <!-- tree -->
      <div class="w-[320px] shrink-0 overflow-y-auto border-r border-outline-variant p-4">
        <p class="mb-4 font-mono text-xs font-bold tracking-[0.1em] text-on-surface-variant">SERVER_TREE</p>
        <template x-for="node in tree" :key="node.path">
          <button @click="scanDir(node.path)"
                  class="block w-full truncate px-2 py-2 text-left font-mono text-sm"
                  :style="`padding-left: ${node.depth * 14 + 8}px`"
                  :class="scanPath === node.path ? 'bg-surface-container text-accent border-l-2 border-accent' : 'text-on-surface-variant hover:text-on-surface'">
            <span x-text="node.open ? '▾' : '▸'" class="mr-1 text-outline"></span>
            <span x-text="node.name"></span>
          </button>
        </template>
      </div>

      <!-- files -->
      <div class="flex min-w-0 flex-1 flex-col">
        <div class="border-b border-outline-variant px-6 py-4">
          <p class="font-mono text-sm text-on-surface-variant">
            <span class="text-outline">ROOT</span>
            <template x-for="crumb in breadcrumbs" :key="crumb">
              <span><span class="mx-2 text-outline">/</span><span class="text-accent" x-text="crumb"></span></span>
            </template>
          </p>
        </div>

        <div class="flex items-center gap-4 border-b border-outline-variant px-6 py-3">
          <button @click="selectAllReducible()" class="font-mono text-xs tracking-[0.1em] text-on-surface-variant hover:text-accent">
            SELECT_ALL_REDUCIBLE
          </button>
          <button @click="selected = new Set(); files = files" class="font-mono text-xs tracking-[0.1em] text-on-surface-variant hover:text-accent">
            CLEAR
          </button>
          <span class="ml-auto font-mono text-xs text-outline" x-text="scanning ? '[ SCANNING... ]' : `[ ${files.length} FILES ]`"></span>
        </div>

        <div class="flex-1 overflow-y-auto p-6">
          <p x-show="!scanning && !files.length" class="font-mono text-sm text-outline">
            [ SELECT A DIRECTORY FROM THE SERVER_TREE ]
          </p>

          <div class="grid gap-3">
            <template x-for="f in files" :key="f.path">
              <label class="panel flex cursor-pointer items-center gap-4 px-4 py-3"
                     :class="{ 'glow': selected.has(f.path), 'opacity-40': f.queued || (!f.wouldReduce && !selected.has(f.path)) }">
                <input type="checkbox" class="h-4 w-4 accent-[#00f2ff]"
                       :disabled="f.queued"
                       :checked="selected.has(f.path)"
                       @change="toggle(f)">
                <span class="min-w-0 flex-1 truncate font-mono text-sm" x-text="f.name"></span>
                <span class="font-mono text-xs text-on-surface-variant" x-text="f.probeError ? 'UNREADABLE' : `${f.width}x${f.height}`"></span>
                <span class="font-mono text-xs text-on-surface-variant" x-text="f.codec ?? '-'"></span>
                <span class="w-20 text-right font-mono text-xs" x-text="fmtSize(f.size)"></span>
                <span x-show="f.queued" class="pill text-toxic">[ QUEUED ]</span>
                <span x-show="!f.queued && !f.wouldReduce && !f.probeError" class="pill text-outline"
                      x-text="`[ ALREADY ${Math.min(f.width, f.height)}P ]`"></span>
              </label>
            </template>
          </div>
        </div>

        <div class="panel flex items-center gap-6 border-t border-outline-variant px-6 py-4">
          <span class="font-mono text-sm text-toxic" x-text="`● ${selected.size} FILES SELECTED`"></span>
          <span class="font-mono text-xs text-on-surface-variant" x-text="`TOTAL_SIZE: ${fmtSize(selectedBytes)}`"></span>
          <button @click="addSelected()" :disabled="!selected.size"
                  class="ml-auto bg-accent px-8 py-3 font-mono text-sm font-bold tracking-[0.1em] text-on-accent disabled:opacity-30">
            + ADD_TO_PIPELINE
          </button>
        </div>
      </div>
    </section>

    <!-- ================= QUEUE (filled in by Task 13) ================= -->
    <section x-show="view === 'queue'" class="p-8" id="queue-view"></section>

  </main>
</div>

<!-- SETTINGS PANEL (filled in by Task 14) -->
<div x-show="settingsOpen" id="settings-panel"></div>

<script src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write the component**

Create `public/app.js`:

```js
function app() {
  return {
    view: location.hash === '#/queue' ? 'queue' : 'browse',
    settingsOpen: false,
    settings: {},
    tree: [],
    scanPath: null,
    scanning: false,
    files: [],
    selected: new Set(),
    jobs: [],

    async boot() {
      this.$watch('view', (v) => { location.hash = `#/${v}`; });
      this.settings = await this.json('/api/settings');
      this.tree = await this.loadDirs('', 0);
      this.poll();
      setInterval(() => { if (!document.hidden) this.poll(); }, 2000);
    },

    async json(url, options) {
      const res = await fetch(url, options);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      return body;
    },

    async loadDirs(p, depth) {
      const { dirs } = await this.json(`/api/browse?path=${encodeURIComponent(p)}`);
      return dirs.map((d) => ({ ...d, depth, open: false }));
    },

    // Lazily expand in place, so a deep tree is never walked up front.
    async scanDir(p) {
      const i = this.tree.findIndex((n) => n.path === p);
      const node = this.tree[i];
      if (node && !node.open) {
        const children = await this.loadDirs(p, node.depth + 1);
        node.open = true;
        this.tree.splice(i + 1, 0, ...children);
      }

      this.scanPath = p;
      this.scanning = true;
      this.selected = new Set();
      try {
        const { files } = await this.json(`/api/scan?path=${encodeURIComponent(p)}`);
        this.files = files;
        this.selectAllReducible();
      } finally {
        this.scanning = false;
      }
    },

    // Recomputed against the current target, so changing the setting re-ticks the list.
    selectAllReducible() {
      const target = this.settings.targetShortSide;
      this.selected = new Set(
        this.files
          .filter((f) => !f.queued && !f.probeError && Math.min(f.width, f.height) > target)
          .map((f) => f.path),
      );
    },

    toggle(f) {
      const next = new Set(this.selected);
      next.has(f.path) ? next.delete(f.path) : next.add(f.path);
      this.selected = next;
    },

    get selectedBytes() {
      return this.files.filter((f) => this.selected.has(f.path)).reduce((n, f) => n + f.size, 0);
    },

    get breadcrumbs() {
      return this.scanPath ? this.scanPath.split('/').filter(Boolean) : [];
    },

    get activeCount() {
      return this.jobs.filter((j) => j.status === 'waiting' || j.status === 'processing').length;
    },

    async addSelected() {
      await this.json('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths: [...this.selected] }),
      });
      this.selected = new Set();
      await this.scanDir(this.scanPath);
      this.view = 'queue';
      this.poll();
    },

    async poll() {
      this.jobs = (await this.json('/api/jobs')).jobs;
    },

    fmtSize(bytes) {
      if (!bytes) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
      return `${(bytes / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
    },
  };
}
```

- [ ] **Step 3: Run it against a real media directory**

```bash
mkdir -p /tmp/vc-media/movies /tmp/vc-data
# drop two or three real video files into /tmp/vc-media/movies first
npm run build
MEDIA_ROOT=/tmp/vc-media DB_PATH=/tmp/vc-data/queue.db node server.js
```

Open `http://localhost:3000`. Expected: sidebar renders in cyan-on-obsidian with sharp
corners, `SERVER_TREE` lists `movies`, clicking it scans and lists the files with
dimensions and sizes, files above 720p are ticked and files at or below 720p are
dimmed with an `[ ALREADY nnnP ]` pill, and the bottom bar totals the selection.
`ADD_TO_PIPELINE` switches to the (still empty) queue view and the sidebar badge
shows the count.

This step needs ffprobe. If ffmpeg is not installed yet: `sudo apt install ffmpeg`.

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/app.js
git commit -m "feat: add app shell and file browser view"
```

---

### Task 13: Queue view

**Files:**
- Modify: `public/index.html` (replace the empty `#queue-view` section)
- Modify: `public/app.js`

**Interfaces:**
- Consumes: `this.jobs` from Task 12, `DELETE /api/jobs/:id`, `POST /api/jobs/:id/requeue`.
- Produces: getters `pending`, `active`, `archive`, `totalSaved`; methods `removeJob(id)`, `requeue(id)`, `savingPct(job)`, `eta(job)`.

- [ ] **Step 1: Replace the queue section in `public/index.html`**

Replace `<section x-show="view === 'queue'" class="p-8" id="queue-view"></section>` with:

```html
    <section x-show="view === 'queue'" class="h-screen overflow-y-auto p-8">
      <div class="mb-8 flex items-start justify-between">
        <h2 class="font-sans text-5xl font-extrabold leading-tight tracking-[-0.02em]">
          DATA_PROCESSOR <span class="text-outline">//</span><br>VIDEO_ENCODE
        </h2>
        <span class="pill" :class="active ? 'text-toxic' : 'text-outline'"
              x-text="active ? '[ ACTIVE ]' : '[ IDLE ]'"></span>
      </div>

      <div class="grid gap-8 lg:grid-cols-[1fr_2fr]">

        <!-- PENDING -->
        <div>
          <p class="mb-3 font-mono text-xs font-bold tracking-[0.1em] text-on-surface-variant">PENDING_QUEUE</p>
          <div class="panel p-4">
            <p x-show="!pending.length" class="font-mono text-sm text-outline">[ EMPTY ]</p>
            <template x-for="job in pending" :key="job.id">
              <div class="flex items-center gap-3 border-b border-outline-variant py-3 last:border-0">
                <div class="min-w-0 flex-1">
                  <p class="truncate font-mono text-sm" x-text="job.name"></p>
                  <p class="font-mono text-xs text-on-surface-variant"
                     x-text="`${fmtSize(job.orig_size)} | ${job.width}x${job.height}`"></p>
                </div>
                <button @click="removeJob(job.id)" class="font-mono text-xs text-outline hover:text-error">[ X ]</button>
              </div>
            </template>
          </div>
        </div>

        <!-- ACTIVE -->
        <div>
          <p class="mb-3 font-mono text-xs font-bold tracking-[0.1em] text-on-surface-variant">ACTIVE_PROCESS</p>
          <div class="panel p-6" :class="active && 'glow'">
            <template x-if="!active">
              <p class="font-mono text-sm text-outline">[ NO ACTIVE ENCODE ]</p>
            </template>

            <template x-if="active">
              <div>
                <div class="flex items-start justify-between">
                  <div class="min-w-0">
                    <p class="truncate font-mono text-xl" x-text="active.name"></p>
                    <p class="mt-1 font-mono text-xs text-on-surface-variant"
                       x-text="`ENCODING: H.265 / HEVC | ${active.width}x${active.height} → ${active.settings.targetShortSide}P | ${active.settings.encoder.toUpperCase()}`"></p>
                  </div>
                  <div class="shrink-0 text-right">
                    <p class="font-sans text-5xl font-extrabold text-accent" x-text="`${active.progress}%`"></p>
                    <p class="font-mono text-xs tracking-[0.1em] text-on-surface-variant">PROCESSING...</p>
                  </div>
                </div>

                <div class="bar relative mt-6">
                  <div class="absolute inset-y-0 left-0 bg-accent opacity-90"
                       :style="`width: ${active.progress}%`"></div>
                </div>

                <div class="mt-6 grid grid-cols-3 gap-4 border-t border-outline-variant pt-4">
                  <div>
                    <p class="font-mono text-xs tracking-[0.1em] text-outline">TIME_REMAINING</p>
                    <p class="font-mono text-sm" x-text="eta(active)"></p>
                  </div>
                  <div>
                    <p class="font-mono text-xs tracking-[0.1em] text-outline">CURRENT_BITRATE</p>
                    <p class="font-mono text-sm" x-text="active.bitrate ?? '-'"></p>
                  </div>
                  <div>
                    <p class="font-mono text-xs tracking-[0.1em] text-outline">ORIGINAL_SIZE</p>
                    <p class="font-mono text-sm" x-text="fmtSize(active.orig_size)"></p>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- ARCHIVE -->
      <div class="mt-10">
        <p class="mb-3 font-mono text-xs font-bold tracking-[0.1em] text-on-surface-variant">COMPLETED_ARCHIVE</p>
        <div class="panel">
          <table class="w-full">
            <thead>
              <tr class="border-b border-outline-variant font-mono text-xs tracking-[0.1em] text-outline">
                <th class="px-6 py-4 text-left">FILENAME</th>
                <th class="px-6 py-4 text-right">ORIGINAL</th>
                <th class="px-6 py-4 text-right">COMPRESSED</th>
                <th class="px-6 py-4 text-right">SAVING</th>
                <th class="px-6 py-4 text-right"></th>
              </tr>
            </thead>
            <tbody>
              <template x-for="job in archive" :key="job.id">
                <tr class="border-b border-outline-variant last:border-0 align-top">
                  <td class="px-6 py-4">
                    <p class="font-mono text-sm" x-text="job.name"></p>
                    <p x-show="job.error" class="mt-1 max-w-xl whitespace-pre-wrap font-mono text-xs text-error"
                       x-text="job.error"></p>
                  </td>
                  <td class="px-6 py-4 text-right font-mono text-sm text-on-surface-variant"
                      x-text="fmtSize(job.orig_size)"></td>
                  <td class="px-6 py-4 text-right font-mono text-sm text-accent"
                      x-text="job.new_size ? fmtSize(job.new_size) : '-'"></td>
                  <td class="px-6 py-4 text-right font-mono text-sm"
                      :class="{ 'text-toxic': job.status === 'done', 'text-outline': job.status === 'skipped', 'text-error': job.status === 'failed' }"
                      x-text="job.status === 'done' ? `${savingPct(job)}% REDUCTION` : `[ ${job.status.toUpperCase()} ]`"></td>
                  <td class="px-6 py-4 text-right">
                    <button x-show="job.status !== 'done'" @click="requeue(job.id)"
                            class="font-mono text-xs text-outline hover:text-accent">[ RETRY ]</button>
                  </td>
                </tr>
              </template>
              <tr x-show="!archive.length">
                <td colspan="5" class="px-6 py-6 font-mono text-sm text-outline">[ NOTHING PROCESSED YET ]</td>
              </tr>
            </tbody>
            <tfoot x-show="totalSaved > 0">
              <tr class="border-t border-outline-variant">
                <td colspan="3" class="px-6 py-4 font-mono text-xs tracking-[0.1em] text-outline">TOTAL_RECLAIMED</td>
                <td colspan="2" class="px-6 py-4 text-right font-mono text-sm text-toxic" x-text="fmtSize(totalSaved)"></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </section>
```

- [ ] **Step 2: Add the getters and methods to `public/app.js`**

Insert into the object returned by `app()`, before `fmtSize`:

```js
    get pending() {
      return this.jobs.filter((j) => j.status === 'waiting');
    },

    get active() {
      return this.jobs.find((j) => j.status === 'processing') ?? null;
    },

    get archive() {
      return this.jobs
        .filter((j) => ['done', 'skipped', 'failed'].includes(j.status))
        .sort((a, b) => (b.finished_at ?? 0) - (a.finished_at ?? 0));
    },

    get totalSaved() {
      return this.jobs
        .filter((j) => j.status === 'done')
        .reduce((n, j) => n + (j.orig_size - j.new_size), 0);
    },

    savingPct(job) {
      if (!job.orig_size || !job.new_size) return 0;
      return Math.round((1 - job.new_size / job.orig_size) * 100);
    },

    // Extrapolated from percent alone: ffmpeg's own speed figure swings too much
    // early on to be worth reading, and this is honest about being an estimate.
    eta(job) {
      if (!job.progress || !job.duration) return '--:--';
      const elapsed = (Date.now() - (job.started_at ?? Date.now())) / 1000;
      if (!elapsed) return '--:--';
      const total = elapsed / (job.progress / 100);
      const left = Math.max(0, Math.round(total - elapsed));
      return `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
    },

    async removeJob(id) {
      await this.json(`/api/jobs/${id}`, { method: 'DELETE' });
      await this.poll();
    },

    async requeue(id) {
      await this.json(`/api/jobs/${id}/requeue`, { method: 'POST' });
      await this.poll();
    },
```

`eta` reads `job.started_at`, which does not exist yet. Add it:

- In `db.js`, add `started_at INTEGER` to the `jobs` schema (after `finished_at`) and
  add `'started_at'` to the `WRITABLE` set.
- In `worker.js`, change the first `updateJob` in `runJob` to
  `updateJob(db, job.id, { status: 'processing', progress: 0, bitrate: null, error: null, started_at: now() });`
- In `test.js`, add to the `runJob` describe block:

```js
  test('started_at is stamped when the job begins', async () => {
    const { db, job } = prepare();
    await runJob(db, job, deps({ spawn: fakeSpawn({ writesOutput: 'small' }) }));
    assert.equal(getJob(db, job.id).started_at, 1700000000000);
    fs.rmSync(root, { recursive: true, force: true });
  });
```

- [ ] **Step 3: Run the tests**

Run: `npm test`
Expected: PASS, including the new `started_at` test.

- [ ] **Step 4: Verify end to end with a real encode**

```bash
npm run build
rm -f /tmp/vc-data/queue.db
MEDIA_ROOT=/tmp/vc-media DB_PATH=/tmp/vc-data/queue.db node server.js
```

Put at least one video above 720p in `/tmp/vc-media/movies`. Queue it from the browse
view. Expected: it appears in `PENDING_QUEUE`, moves to `ACTIVE_PROCESS` within two
seconds, the percentage and segmented bar advance, and on completion it lands in
`COMPLETED_ARCHIVE` in toxic green with a reduction percentage. Then confirm on disk:

```bash
ls -la /tmp/vc-media/movies /tmp/vc-media/.trash/movies
```

Expected: the new file is in `movies/`, the original is under `.trash/movies/`.

If the encode fails with a VAAPI device error, switch the encoder to `software` in
ENCODE_PARAMS and retry — that confirms the fallback path and isolates the failure to
hardware access rather than the app.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js db.js worker.js test.js
git commit -m "feat: add encode queue view with live progress and archive"
```

---

### Task 14: Settings panel

**Files:**
- Modify: `public/index.html` (replace the empty `#settings-panel` div)
- Modify: `public/app.js`

**Interfaces:**
- Consumes: `GET /api/settings`, `PUT /api/settings`.
- Produces: `saveSettings()`, `settingsError`.

- [ ] **Step 1: Replace the settings panel in `public/index.html`**

Replace `<div x-show="settingsOpen" id="settings-panel"></div>` with:

```html
<div x-show="settingsOpen" x-cloak class="fixed inset-0 z-50 flex" @keydown.escape.window="settingsOpen = false">
  <div class="flex-1 bg-black/60" @click="settingsOpen = false"></div>

  <div class="panel glow w-[420px] overflow-y-auto p-8">
    <div class="flex items-center justify-between">
      <h3 class="font-mono text-lg font-bold tracking-[0.1em] text-accent">ENCODE_PARAMS</h3>
      <button @click="settingsOpen = false" class="font-mono text-sm text-outline hover:text-on-surface">[ X ]</button>
    </div>

    <p class="mt-2 font-mono text-xs text-on-surface-variant">
      Applied to files as they are added to the pipeline. Queued jobs keep the
      settings they were added with.
    </p>

    <div class="mt-8 flex flex-col gap-6">
      <label class="block">
        <span class="font-mono text-xs font-bold tracking-[0.1em] text-on-surface-variant">TARGET_SHORT_SIDE</span>
        <select x-model.number="settings.targetShortSide"
                class="mt-2 w-full border border-outline-variant bg-surface-container-low px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none">
          <template x-for="v in [480, 540, 720, 1080, 1440]" :key="v">
            <option :value="v" x-text="`${v}p`"></option>
          </template>
        </select>
      </label>

      <label class="block">
        <span class="font-mono text-xs font-bold tracking-[0.1em] text-on-surface-variant">
          QUALITY <span class="text-outline">(QP/CRF — lower is better)</span>
        </span>
        <div class="mt-2 flex items-center gap-4">
          <input type="range" min="18" max="32" step="1" x-model.number="settings.quality" class="flex-1 accent-[#00f2ff]">
          <span class="w-10 text-right font-mono text-lg text-accent" x-text="settings.quality"></span>
        </div>
      </label>

      <label class="block">
        <span class="font-mono text-xs font-bold tracking-[0.1em] text-on-surface-variant">ENCODER</span>
        <select x-model="settings.encoder"
                class="mt-2 w-full border border-outline-variant bg-surface-container-low px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none">
          <option value="vaapi">vaapi — Intel hardware (recommended)</option>
          <option value="qsv">qsv — Intel Quick Sync</option>
          <option value="software">software — libx265 (slow, no GPU needed)</option>
        </select>
      </label>

      <label class="block" x-show="settings.encoder === 'vaapi'">
        <span class="font-mono text-xs font-bold tracking-[0.1em] text-on-surface-variant">VAAPI_DEVICE</span>
        <input type="text" x-model="settings.vaapiDevice"
               class="mt-2 w-full border border-outline-variant bg-surface-container-low px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none">
      </label>

      <label class="block">
        <span class="font-mono text-xs font-bold tracking-[0.1em] text-on-surface-variant">CONTAINER</span>
        <select x-model="settings.container"
                class="mt-2 w-full border border-outline-variant bg-surface-container-low px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none">
          <option value="mp4">mp4 — maximum compatibility, drops subtitles</option>
          <option value="mkv">mkv — keeps subtitles and extra streams</option>
        </select>
      </label>

      <label class="block">
        <span class="font-mono text-xs font-bold tracking-[0.1em] text-on-surface-variant">AUDIO_BITRATE</span>
        <input type="text" x-model="settings.audioBitrate" placeholder="128k"
               class="mt-2 w-full border border-outline-variant bg-surface-container-low px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none">
        <span class="mt-1 block font-mono text-xs text-outline">Only used when the source audio is not already AAC.</span>
      </label>
    </div>

    <p x-show="settingsError" class="mt-6 font-mono text-xs text-error" x-text="settingsError"></p>

    <button @click="saveSettings()"
            class="mt-8 w-full bg-accent px-6 py-3 font-mono text-sm font-bold tracking-[0.1em] text-on-accent">
      SAVE_PARAMS
    </button>
  </div>
</div>
```

Add `[x-cloak] { display: none !important; }` to the bottom of `src/app.css` so the
panel does not flash before Alpine boots.

- [ ] **Step 2: Add `saveSettings` to `public/app.js`**

Add `settingsError: null,` to the state, and this method:

```js
    async saveSettings() {
      this.settingsError = null;
      try {
        this.settings = await this.json('/api/settings', {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(this.settings),
        });
        this.settingsOpen = false;
        // The target changed, so which files are worth queueing changed with it.
        if (this.files.length) this.selectAllReducible();
      } catch (err) {
        this.settingsError = err.message;
      }
    },
```

- [ ] **Step 3: Rebuild and verify by hand**

```bash
npm run build
MEDIA_ROOT=/tmp/vc-media DB_PATH=/tmp/vc-data/queue.db node server.js
```

Expected:
- `ENCODE_PARAMS` slides in from the right over a dimmed backdrop; Escape and the
  backdrop both close it.
- Changing TARGET_SHORT_SIDE to 1080 and saving re-ticks the browse list — files at
  1080p or below become dimmed and unticked.
- The sidebar footer text updates to match.
- Typing `999` into AUDIO_BITRATE and saving shows the server's validation message in
  red inside the panel rather than closing it.

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/app.js src/app.css
git commit -m "feat: add encode settings panel"
```

---

### Task 15: Docker packaging and README

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`
- Create: `docker-compose.yml`
- Create: `.env.example`
- Create: `README.md`

**Interfaces:**
- Consumes: the `start` and `build` npm scripts, and the `MEDIA_ROOT` / `DB_PATH` / `PORT` env vars.
- Produces: a runnable image.

- [ ] **Step 1: Write `.dockerignore`**

```
node_modules
.git
docs
public/app.css
public/alpine.js
*.db
```

- [ ] **Step 2: Write the `Dockerfile`**

```dockerfile
# --- build the frontend assets -------------------------------------------------
FROM node:24-slim AS assets
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY src ./src
COPY public ./public
RUN npm run build

# --- runtime -------------------------------------------------------------------
FROM node:24-slim

# intel-media-va-driver-nonfree lives in Debian's non-free component, which the
# base image does not enable. The codename is read from the image so this keeps
# working across base image bumps.
RUN . /etc/os-release && \
    echo "deb http://deb.debian.org/debian ${VERSION_CODENAME} non-free non-free-firmware" \
      > /etc/apt/sources.list.d/nonfree.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg intel-media-va-driver-nonfree vainfo && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY *.js ./
COPY public ./public
COPY --from=assets /app/public/app.css /app/public/alpine.js ./public/

# The named volume inherits this ownership, so the non-root user can write the db.
RUN mkdir -p /data /media && chown -R node:node /data /media
USER node

ENV MEDIA_ROOT=/media DB_PATH=/data/queue.db PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
```

- [ ] **Step 3: Write `.env.example` and `docker-compose.yml`**

`.env.example`:

```
# Absolute path on the host to the media you want compressed.
MEDIA_DIR=/srv/media

# The host's `render` group id — the container user must be in it to open
# /dev/dri/renderD128. Find it with:  getent group render | cut -d: -f3
RENDER_GID=104
```

`docker-compose.yml`:

```yaml
services:
  video-compressor:
    build: .
    ports:
      - "3000:3000"
    devices:
      - /dev/dri:/dev/dri
    group_add:
      - "${RENDER_GID}"
    volumes:
      - "${MEDIA_DIR}:/media"
      - queue-data:/data
    restart: unless-stopped

volumes:
  queue-data:
```

- [ ] **Step 4: Write `README.md`**

````markdown
# video-compressor

A web UI over a server-side ffmpeg queue. Point it at a directory of videos, pick a
target resolution, and it re-encodes anything larger to HEVC using Intel hardware
acceleration. Originals are moved to `.trash` inside the media root, not deleted.

Replaces `docs/videosCompress.sh`, whose encode settings it inherits.

## Run with Docker

```bash
cp .env.example .env
# set MEDIA_DIR to your media directory
# set RENDER_GID to: getent group render | cut -d: -f3
docker compose up -d --build
```

Then open <http://localhost:3000>.

## Run without Docker

```bash
sudo apt install ffmpeg intel-media-va-driver-nonfree vainfo
sudo usermod -aG render "$USER"     # then log out and back in
npm install && npm run build
MEDIA_ROOT=/srv/media DB_PATH=./queue.db npm start
```

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `MEDIA_ROOT` | `/media` | The only directory the app can see or touch |
| `DB_PATH` | `/data/queue.db` | SQLite queue file |
| `PORT` | `3000` | HTTP port |

Encode settings — target resolution, quality, encoder, container, audio bitrate — live
in the UI under ENCODE_PARAMS. Each job stores the settings it was queued with, so
changing them never rewrites work already in the queue.

## How it works

1. Browse a directory. Every video underneath is probed and listed; anything whose
   shorter side is above the target is pre-selected.
2. Add the selection to the pipeline. One encode runs at a time.
3. Each encode writes to a hidden temp file and is only accepted if ffmpeg exits
   cleanly, the duration matches within 3 seconds, and the result is smaller. If it
   is not smaller, the job is marked `skipped` and the original is untouched.
4. On success the original moves to `MEDIA_ROOT/.trash/<same relative path>` and the
   new file takes its place. Nothing ever empties `.trash` — that is a manual
   `rm -rf` when you are satisfied.

Restarting the container is safe: a job interrupted mid-encode is reset to waiting and
its temp file removed. The source is never modified until verification passes.

## Verifying hardware acceleration

```bash
docker compose exec video-compressor vainfo | grep -i hevc
```

You want a line mentioning `VAProfileHEVCMain` with `VAEntrypointEncSlice`. If the
device is missing or the group id is wrong, set the encoder to `software` in
ENCODE_PARAMS — it is much slower but needs no GPU.

## Tests

```bash
npm test
```

The suite covers path safety, the resolution filter and dimension maths, the scanner,
the job store, settings validation, ffmpeg argument construction, the verification
predicate, the progress parser, the trash swap, the worker's outcome handling, and the
HTTP API. It does not require ffmpeg to be installed.
````

- [ ] **Step 5: Build and run the image**

```bash
docker compose build
RENDER_GID=$(getent group render | cut -d: -f3) MEDIA_DIR=/tmp/vc-media docker compose up -d
docker compose exec video-compressor vainfo | grep -i hevc || echo "no hardware hevc"
curl -s localhost:3000/api/settings
docker compose logs --tail 20
```

Expected: the image builds, `/api/settings` returns the defaults, and the UI loads at
`http://localhost:3000` with styling intact (proving `app.css` and `alpine.js` were
copied from the assets stage). Queue one file and confirm it encodes.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml .env.example README.md
git commit -m "chore: add docker packaging and readme"
```

---

### Task 16: Encode schedule window

**Files:**
- Modify: `db.js` (settings defaults and validation)
- Modify: `worker.js` (the predicate and the loop gate)
- Modify: `server.js` (schedule state on `GET /api/jobs`)
- Modify: `public/app.js`, `public/index.html` (banner and controls)
- Modify: `docker-compose.yml`, `.env.example`, `README.md`
- Modify: `test.js`

**Interfaces:**
- Consumes: `getSettings`, `validateSettings`, `startWorker`.
- Produces: settings keys `scheduleEnabled` (boolean), `scheduleStartHour` (0–23), `scheduleEndHour` (0–23); `withinSchedule(date, settings) -> boolean` exported from `worker.js`; a `schedule` object on the `GET /api/jobs` response.

**Behaviour:** the worker checks the window only *before* picking up a job, so a
running encode is never interrupted by the window closing. That is the requirement,
and it means there is no cancellation path to write.

- [ ] **Step 1: Write the failing tests**

Append to `test.js`:

```js
import { withinSchedule } from './worker.js';

describe('withinSchedule', () => {
  const at = (hour) => new Date(2026, 0, 15, hour, 30, 0);
  const sched = (over) => ({ ...DEFAULT_SETTINGS, ...over });

  test('is always open when scheduling is disabled', () => {
    for (const h of [0, 6, 13, 23]) {
      assert.equal(withinSchedule(at(h), sched({ scheduleEnabled: false })), true);
    }
  });

  test('a normal window is open inside it and shut outside it', () => {
    const s = sched({ scheduleEnabled: true, scheduleStartHour: 2, scheduleEndHour: 6 });
    assert.equal(withinSchedule(at(1), s), false);
    assert.equal(withinSchedule(at(2), s), true, 'open on the start hour');
    assert.equal(withinSchedule(at(5), s), true, 'open through the last hour');
    assert.equal(withinSchedule(at(6), s), false, 'end hour is exclusive');
    assert.equal(withinSchedule(at(14), s), false);
  });

  test('a window wrapping midnight is open on both sides of it', () => {
    const s = sched({ scheduleEnabled: true, scheduleStartHour: 22, scheduleEndHour: 6 });
    assert.equal(withinSchedule(at(21), s), false);
    assert.equal(withinSchedule(at(22), s), true);
    assert.equal(withinSchedule(at(23), s), true);
    assert.equal(withinSchedule(at(0), s), true);
    assert.equal(withinSchedule(at(5), s), true);
    assert.equal(withinSchedule(at(6), s), false);
  });
});

describe('schedule settings', () => {
  test('scheduling is off by default with a 2am-6am window', () => {
    assert.equal(DEFAULT_SETTINGS.scheduleEnabled, false);
    assert.equal(DEFAULT_SETTINGS.scheduleStartHour, 2);
    assert.equal(DEFAULT_SETTINGS.scheduleEndHour, 6);
  });

  test('accepts a valid window', () => {
    const s = validateSettings({ scheduleEnabled: true, scheduleStartHour: 22, scheduleEndHour: 6 });
    assert.equal(s.scheduleEnabled, true);
    assert.equal(s.scheduleStartHour, 22);
  });

  for (const bad of [
    { scheduleStartHour: 24 },
    { scheduleStartHour: -1 },
    { scheduleEndHour: 6.5 },
    { scheduleEnabled: 'yes' },
    { scheduleEnabled: true, scheduleStartHour: 3, scheduleEndHour: 3 },
  ]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      assert.throws(() => validateSettings(bad), (err) => err.status === 400);
    });
  }

  test('an equal start and end is allowed while scheduling is off', () => {
    assert.doesNotThrow(() => validateSettings({ scheduleStartHour: 3, scheduleEndHour: 3 }));
  });
});
```

Add to the existing `http api` describe block:

```js
  test('jobs response reports the schedule state', async () => {
    await send('PUT', '/api/settings', {
      ...DEFAULT_SETTINGS, scheduleEnabled: true, scheduleStartHour: 2, scheduleEndHour: 6,
    });
    const { body } = await get('/api/jobs');
    assert.equal(body.schedule.enabled, true);
    assert.equal(body.schedule.startHour, 2);
    assert.equal(body.schedule.endHour, 6);
    assert.equal(typeof body.schedule.open, 'boolean');

    await send('PUT', '/api/settings', DEFAULT_SETTINGS);
    assert.equal((await get('/api/jobs')).body.schedule.open, true, 'always open when disabled');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `withinSchedule is not a function`, plus the default-settings
assertions.

- [ ] **Step 3: Add the settings fields and validation**

In `db.js`, extend `DEFAULT_SETTINGS`:

```js
export const DEFAULT_SETTINGS = {
  targetShortSide: 720,
  quality: 25,
  encoder: 'vaapi',
  container: 'mp4',
  audioBitrate: '128k',
  vaapiDevice: '/dev/dri/renderD128',
  scheduleEnabled: false,
  scheduleStartHour: 2,
  scheduleEndHour: 6,
};
```

In `validateSettings`, add these checks before the `return`:

```js
  if (typeof s.scheduleEnabled !== 'boolean') {
    throw badRequest('scheduleEnabled must be true or false');
  }
  for (const key of ['scheduleStartHour', 'scheduleEndHour']) {
    if (!Number.isInteger(s[key]) || s[key] < 0 || s[key] > 23) {
      throw badRequest(`${key} must be an integer hour between 0 and 23`);
    }
  }
  // Only meaningful when the schedule is on; an equal pair would otherwise be an
  // empty window that silently stops the queue forever.
  if (s.scheduleEnabled && s.scheduleStartHour === s.scheduleEndHour) {
    throw badRequest('the schedule window start and end hours must differ');
  }
```

and add the three keys to the returned object:

```js
    scheduleEnabled: s.scheduleEnabled,
    scheduleStartHour: s.scheduleStartHour,
    scheduleEndHour: s.scheduleEndHour,
```

Task 5's `defaults match the shell script` test asserts `deepEqual` against a literal
object, so it now fails. Add the three keys to that literal:

```js
      vaapiDevice: '/dev/dri/renderD128',
      scheduleEnabled: false,
      scheduleStartHour: 2,
      scheduleEndHour: 6,
    });
```

- [ ] **Step 4: Add the predicate and gate the worker loop**

In `worker.js`, add `getSettings` to the import from `./db.js`, then:

```js
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
```

Replace `startWorker` with:

```js
export function startWorker(db, deps) {
  const { idleMs = 2000, now = Date.now } = deps;
  let stopped = false;

  (async () => {
    while (!stopped) {
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
    }
  })();

  return () => { stopped = true; };
}
```

- [ ] **Step 5: Report the schedule state from the API**

In `server.js`, import `withinSchedule` from `./worker.js` and replace the
`GET /api/jobs` handler with:

```js
  app.get('/api/jobs', (req, res) => {
    const settings = getSettings(db);
    res.json({
      jobs: listJobs(db).map((job) => ({
        ...job,
        path: rel(job.path),
        name: path.basename(job.path),
        final_path: rel(job.final_path),
        trash_path: rel(job.trash_path),
        settings: JSON.parse(job.settings_json),
      })),
      // Computed here, not in the browser: the server's clock is the one that
      // actually gates the worker.
      schedule: {
        enabled: settings.scheduleEnabled,
        startHour: settings.scheduleStartHour,
        endHour: settings.scheduleEndHour,
        open: withinSchedule(new Date(), settings),
      },
    });
  });
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit the backend**

```bash
git add db.js worker.js server.js test.js
git commit -m "feat: only start encodes inside an optional schedule window"
```

- [ ] **Step 8: Show the schedule in the queue view**

In `public/app.js`, add `schedule: { enabled: false, open: true, startHour: 2, endHour: 6 },`
to the state and replace `poll` with:

```js
    async poll() {
      const body = await this.json('/api/jobs');
      this.jobs = body.jobs;
      this.schedule = body.schedule;
    },
```

Add two helpers next to `fmtSize`:

```js
    hhmm(hour) {
      return `${String(hour).padStart(2, '0')}:00`;
    },

    get scheduleHeld() {
      return this.schedule.enabled && !this.schedule.open && this.pending.length > 0;
    },
```

In `public/index.html`, insert directly above the `PENDING_QUEUE` label
(`<p class="mb-3 font-mono text-xs font-bold tracking-[0.1em] text-on-surface-variant">PENDING_QUEUE</p>`):

```html
          <div x-show="scheduleHeld" class="panel mb-3 border-magenta px-4 py-3">
            <p class="font-mono text-xs font-bold tracking-[0.1em] text-magenta-soft"
               x-text="`[ SCHEDULED — QUEUE RESUMES AT ${hhmm(schedule.startHour)} ]`"></p>
            <p class="mt-1 font-mono text-xs text-on-surface-variant"
               x-text="`${pending.length} file(s) held. Encoding runs ${hhmm(schedule.startHour)}–${hhmm(schedule.endHour)}.`"></p>
          </div>

          <p x-show="schedule.enabled && schedule.open" class="mb-3 font-mono text-xs tracking-[0.1em] text-toxic"
             x-text="`[ WINDOW OPEN UNTIL ${hhmm(schedule.endHour)} ]`"></p>
```

Also change the `[ ACTIVE ] / [ IDLE ]` pill at the top of the queue view so a held
queue does not read as merely idle. Replace that `<span>` with:

```html
        <span class="pill"
              :class="active ? 'text-toxic' : scheduleHeld ? 'text-magenta-soft' : 'text-outline'"
              x-text="active ? '[ ACTIVE ]' : scheduleHeld ? '[ WAITING FOR WINDOW ]' : '[ IDLE ]'"></span>
```

- [ ] **Step 9: Add the schedule controls to the settings panel**

In `public/index.html`, inside the settings panel's `<div class="mt-8 flex flex-col gap-6">`,
after the AUDIO_BITRATE label, add:

```html
      <div class="border-t border-outline-variant pt-6">
        <label class="flex cursor-pointer items-center gap-3">
          <input type="checkbox" x-model="settings.scheduleEnabled" class="h-4 w-4 accent-[#00f2ff]">
          <span class="font-mono text-xs font-bold tracking-[0.1em] text-on-surface-variant">ENCODE_SCHEDULE</span>
        </label>
        <p class="mt-2 font-mono text-xs text-outline">
          Only start new encodes inside this window. A file already encoding when the
          window closes is allowed to finish.
        </p>

        <div x-show="settings.scheduleEnabled" class="mt-4 flex items-center gap-3">
          <select x-model.number="settings.scheduleStartHour"
                  class="flex-1 border border-outline-variant bg-surface-container-low px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none">
            <template x-for="h in 24" :key="h">
              <option :value="h - 1" x-text="hhmm(h - 1)"></option>
            </template>
          </select>
          <span class="font-mono text-sm text-outline">→</span>
          <select x-model.number="settings.scheduleEndHour"
                  class="flex-1 border border-outline-variant bg-surface-container-low px-3 py-2 font-mono text-sm focus:border-accent focus:outline-none">
            <template x-for="h in 24" :key="h">
              <option :value="h - 1" x-text="hhmm(h - 1)"></option>
            </template>
          </select>
        </div>
      </div>
```

In the sidebar footer, add a third line under the existing two:

```html
      <p x-show="schedule.enabled" class="font-mono text-xs text-outline"
         x-text="`WINDOW: ${hhmm(schedule.startHour)}–${hhmm(schedule.endHour)}`"></p>
```

- [ ] **Step 10: Verify by hand**

```bash
npm run build
MEDIA_ROOT=/tmp/vc-media DB_PATH=/tmp/vc-data/queue.db node server.js
```

Queue two or three files, then open ENCODE_PARAMS, tick ENCODE_SCHEDULE and set a
window that does **not** contain the current time (e.g. if it is 15:00, set 02:00 → 06:00).
Save.

Expected within two seconds: the magenta `[ SCHEDULED — QUEUE RESUMES AT 02:00 ]`
banner appears above PENDING_QUEUE, the header pill reads `[ WAITING FOR WINDOW ]`,
the sidebar shows `WINDOW: 02:00–06:00`, and no job moves to `processing`.

Now set the window to one that **does** contain the current time (e.g. 00:00 → 23:00).
Expected: the banner is replaced by the green `[ WINDOW OPEN UNTIL 23:00 ]` line and
the first job starts within two seconds.

To confirm a running encode is not interrupted: with a job actively encoding, set the
window to one that excludes now. Expected: the active job's percentage keeps climbing
to completion, and only then does the queue stall with the banner shown.

Finally, untick ENCODE_SCHEDULE and confirm the queue drains continuously with no
schedule UI shown at all.

- [ ] **Step 11: Set the container timezone**

Without `TZ` the container runs on UTC and a "2am" window fires at the wrong local
time. In `docker-compose.yml`, add to the service:

```yaml
    environment:
      TZ: "${TZ:-UTC}"
```

In `.env.example`, add:

```
# Timezone the encode schedule is evaluated in. Without this the container runs on
# UTC and a 2am window fires at the wrong local time.  cat /etc/timezone
TZ=Europe/London
```

In `README.md`, add `TZ` to the configuration table:

```
| `TZ` | `UTC` | Timezone the encode schedule window is evaluated in |
```

and add this section after "How it works":

```markdown
## Scheduling

By default the queue drains as soon as you add to it. Under ENCODE_PARAMS you can
restrict encoding to a nightly window — 02:00 to 06:00, say. Windows that wrap
midnight (22:00 → 06:00) work.

The window only gates *starting* a file. If an encode is running when the window
closes it finishes normally; the worker simply does not pick up the next one. While
the queue is held the DATA_PROCESSOR view says so.

The window is evaluated in the server's local timezone, so set `TZ` in `.env`.
```

- [ ] **Step 12: Verify in Docker and commit**

```bash
docker compose build
docker compose up -d
docker compose exec video-compressor date
```

Expected: `date` prints your local time, not UTC.

```bash
git add public/index.html public/app.js docker-compose.yml .env.example README.md
git commit -m "feat: surface the encode schedule in the UI and set container TZ"
```

---

## Self-Review Notes

Checked against the spec:

- Every spec section maps to a task: path safety → 1, dimension maths → 2, scanning → 3, data model and recovery → 4, settings → 5, encode commands → 6, verification → 7, progress and trash → 8, worker → 9, API → 10, Tailwind → 11, browse view → 12, queue view → 13, settings panel → 14, Docker and docs → 15, scheduling → 16.
- Task 16 is a full-stack slice rather than four edits spread through the earlier tasks. It arrived after tasks 1–15 were written, and scheduling reviews as one thing — predicate, gate, API field, banner, controls, timezone. Splitting it across the existing numbering would have made every earlier task's diff misleading. It does force one edit back into Task 5's test, which step 3 spells out.
- `started_at` was not in the spec's schema. The spec's ACTIVE_PROCESS card requires a TIME_REMAINING readout, which needs an encode start time. Task 13 adds the column, the writable-field entry, the worker write and a test.
- `POST /api/jobs` resolves and probes every path before inserting any of them, so one bad path rejects the whole request rather than half-queueing it. The API test asserts this.
- Names are consistent across tasks: `resolveSafe`, `wouldReduce`, `targetDims`, `scanTree`, `probeVideo`, `probeAudioCodec`, `listDirs`, `open`, `addJobs`, `listJobs`, `getJob`, `nextWaiting`, `updateJob`, `deleteJob`, `requeueJob`, `recoverProcessing`, `validateSettings`, `getSettings`, `putSettings`, `buildEncodeArgs`, `verifyEncode`, `createProgressParser`, `percentFrom`, `swapInPlace`, `tempPathFor`, `finalPathFor`, `runJob`, `startWorker`, `cleanupTempFiles`, `createApp`.
- Tasks 12, 13 and 14 have no unit tests. The frontend is markup and a thin fetch layer; its verification is the by-hand checklist in each task's run step, including a real end-to-end encode in Task 13 step 4. Adding a headless browser for this would cost more than it catches.
