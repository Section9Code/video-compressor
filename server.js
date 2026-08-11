import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addJobs, deleteJob, getJob, getSettings, listJobs, open,
  putSettings, recoverProcessing, requeueJob,
} from './db.js';
import { cleanupTempFiles, startWorker, withinSchedule } from './worker.js';
import { badRequest, listDirs, probeVideo, resolveSafe, scanTree, wouldReduce } from './media.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ db, mediaRoot, scan = scanTree, probe = probeVideo }) {
  const app = express();
  // The spec anticipates trees of a few thousand files, and POST /api/jobs sends one
  // relative path per selected file — well past express's 100kb default.
  app.use(express.json({ limit: '5mb' }));

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
    // `done` is deliberately not "queued": that file is finished, and re-queueing it
    // at a lower target is a legitimate thing to want. skipped/failed still block,
    // since those rows are the SKIP_LIST and carry their own RETRY action.
    const queued = new Set(listJobs(db).filter((j) => j.status !== 'done').map((j) => j.path));
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
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error(`${req.method} ${req.originalUrl}:`, err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}

// resolveSafe realpaths internally, so mediaRoot has to be a realpath too or every
// path it returns is relative to the wrong root: rel() would emit ../mnt/... and
// swapInPlace's trash path would land outside .trash.
export function mediaRootFromEnv(env = process.env) {
  const raw = env.MEDIA_ROOT ?? '/media';
  try {
    return fs.realpathSync(raw);
  } catch (err) {
    // Misconfiguration is the first thing anyone hits; a raw ENOENT stack is a
    // poor way to say "that directory isn't there".
    throw new Error(`MEDIA_ROOT is not a readable directory: ${raw} (${err.code})`, { cause: err });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let mediaRoot;
  try {
    mediaRoot = mediaRootFromEnv();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
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
