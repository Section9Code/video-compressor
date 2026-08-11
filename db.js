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

// Columns added to `jobs` after its initial release. CREATE TABLE IF NOT EXISTS is a
// no-op against an existing table that predates a column, so an upgrade needs an
// explicit ALTER TABLE too — this is the only place a future column needs adding.
const ADDED_COLUMNS = { started_at: 'INTEGER' };

export function open(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);

  const existing = new Set(db.prepare('PRAGMA table_info(jobs)').all().map((c) => c.name));
  for (const [name, type] of Object.entries(ADDED_COLUMNS)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${type}`);
  }

  return db;
}

export function addJobs(db, files, settings) {
  const snapshot = JSON.stringify(settings);
  const now = Date.now();
  // `path UNIQUE` is the SKIP_LIST replacement: a waiting/processing/skipped/failed
  // row keeps its path out of the queue, and skipped/failed have RETRY. A `done`
  // row must not, though — when the container matches the source extension the
  // finished file inherits that path, and lowering the target later has to be able
  // to queue it again. So a conflict with a done row recycles the row (same shape
  // as RETRY) with freshly probed metadata; any other status still no-ops, and the
  // DO UPDATE reports changes=1 so the caller never sees a phantom `added: 0`.
  const stmt = db.prepare(`
    INSERT INTO jobs
      (path, status, width, height, codec, orig_size, duration, settings_json, created_at)
    VALUES (?, 'waiting', ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (path) DO UPDATE SET
      status = 'waiting',
      width = excluded.width, height = excluded.height, codec = excluded.codec,
      orig_size = excluded.orig_size, duration = excluded.duration,
      settings_json = excluded.settings_json, created_at = excluded.created_at,
      progress = 0, bitrate = NULL, new_size = NULL, final_path = NULL,
      trash_path = NULL, error = NULL, finished_at = NULL, started_at = NULL
    WHERE jobs.status = 'done'
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
  scheduleEnabled: false,
  scheduleStartHour: 2,
  scheduleEndHour: 6,
  trashRetentionHours: 24,
};

export const TARGETS = [480, 540, 720, 1080, 1440];
export const ENCODERS = ['vaapi', 'qsv', 'software'];
export const CONTAINERS = ['mp4', 'mkv'];
// An enum, not a free number: nothing arbitrary should reach code that deletes files.
// 0 means "keep originals forever" and is the off switch.
export const RETENTIONS = [0, 24, 48, 168];

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
  if (!RETENTIONS.includes(s.trashRetentionHours)) {
    throw badRequest(`trashRetentionHours must be one of ${RETENTIONS.join(', ')}`);
  }

  return {
    targetShortSide: s.targetShortSide,
    quality: s.quality,
    encoder: s.encoder,
    container: s.container,
    audioBitrate: s.audioBitrate,
    vaapiDevice: s.vaapiDevice,
    scheduleEnabled: s.scheduleEnabled,
    scheduleStartHour: s.scheduleStartHour,
    scheduleEndHour: s.scheduleEndHour,
    trashRetentionHours: s.trashRetentionHours,
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

const HOUR_MS = 3600_000;

// The clock is the job row, never the filesystem: rename preserves mtime, so a file
// trashed today but authored years ago keeps its old mtime and an age-based sweep
// would delete it instantly. This also bounds the sweep to originals this app
// trashed itself — anything else under .trash is never touched.
export function expiredTrash(db, retentionHours, now = Date.now()) {
  if (!retentionHours) return [];
  return db.prepare(`
    SELECT * FROM jobs
     WHERE status = 'done' AND trash_path IS NOT NULL AND finished_at < ?
     ORDER BY id
  `).all(now - retentionHours * HOUR_MS);
}
