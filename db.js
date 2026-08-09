import { DatabaseSync } from 'node:sqlite';
import { badRequest } from './media.js';

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
  finished_at   INTEGER,
  started_at    INTEGER
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
  'final_path', 'trash_path', 'error', 'finished_at', 'started_at',
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
