# Video Compressor — Design

Date: 2026-08-09

A self-hosted web app that manages a queue of server-side video files and re-encodes
them to a lower resolution with HEVC, using Intel hardware acceleration. It is a
long-running, stateful replacement for `docs/videosCompress.sh`, which it mirrors
closely in encode behaviour.

## Decisions

| Question | Decision |
|---|---|
| Originals | Replaced, but moved to a trash folder rather than deleted |
| Frontend | Alpine.js + Tailwind v4, styled per `docs/design/` ("Cybernetic Core") |
| Backend | Node 24 + Express, `node:sqlite`, `node:child_process` |
| Folder scan | Recursive; shows every video found, pre-selects only those that would shrink |
| Settings | Global panel, snapshotted onto each job at enqueue time |
| Worker | One job at a time, drains automatically, resumes after restart |
| Browse scope | Single `MEDIA_ROOT`, enforced server-side |
| Progress | Real percent, parsed from `ffmpeg -progress` |
| Deployment | Docker, with `/dev/dri` passed through; software encode as a fallback |

## Architecture

A single Node process serves the API and the static frontend, and runs the encode
worker as an async loop in the same process. No queue broker, no second container.

```
server.js              Express: static files + JSON API
db.js                  node:sqlite schema, queries, boot-time recovery
media.js               path safety, recursive scan, ffprobe, dimension maths
worker.js              the encode loop
src/app.css            Tailwind @theme tokens (source)
public/index.html      Alpine markup, both views
public/app.js          Alpine component
public/app.css         built by Tailwind CLI, gitignored
test.js                node:test over the logic that can silently be wrong
Dockerfile
package.json
```

Runtime dependency: `express`. Build-time: `@tailwindcss/cli`. Everything else is
Node stdlib.

## Data model

SQLite at `DB_PATH` (default `/data/queue.db`), created on boot if absent.

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id            INTEGER PRIMARY KEY,
  path          TEXT    NOT NULL UNIQUE,   -- absolute source path
  status        TEXT    NOT NULL,          -- waiting|processing|done|failed|skipped
  width         INTEGER,
  height        INTEGER,
  codec         TEXT,
  orig_size     INTEGER,
  new_size      INTEGER,
  duration      REAL,                      -- seconds, from ffprobe at enqueue
  progress      INTEGER NOT NULL DEFAULT 0,-- 0-100, only meaningful while processing
  bitrate       TEXT,                      -- last value from -progress, for the UI
  final_path    TEXT,                      -- differs from path when container changes
  trash_path    TEXT,                      -- where the original went
  settings_json TEXT    NOT NULL,          -- snapshot at enqueue
  error         TEXT,
  created_at    INTEGER NOT NULL,
  finished_at   INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL
);
```

`path UNIQUE` is what stops a re-scan from double-queueing, and it is also what
replaces the script's `SKIP_LIST`: a file that came out `skipped` keeps its row, so
scanning its folder again will not re-queue it. The UI offers a "requeue" action on
`skipped` and `failed` rows that resets the row to `waiting`.

### Status meanings

- `waiting` — queued, not started
- `processing` — ffmpeg running; `progress` is live
- `done` — encoded, verified, original moved to trash, new file in place
- `skipped` — encode succeeded but the result was not smaller; original untouched
- `failed` — ffmpeg errored, or verification failed; original untouched, `error` set

The user asked for three states. `skipped` and `failed` are real outcomes of the
script's own logic and need somewhere to live; the UI groups them visually with
`done` in the archive table rather than giving them their own screens.

## Settings

One row, defaulted from the script:

```js
{
  targetShortSide: 720,      // 480 | 540 | 720 | 1080 | 1440
  quality: 25,               // QP / CRF; lower = better, 18-32 in the UI
  encoder: "vaapi",          // vaapi | qsv | software
  container: "mp4",          // mp4 | mkv
  audioBitrate: "128k",
  vaapiDevice: "/dev/dri/renderD128"
}
```

`PUT /api/settings` validates each field against its allowed set or range and rejects
the whole body on any violation. Changing settings never touches an existing job —
each job carries the snapshot it was created with in `settings_json`.

## HTTP API

All paths in requests and responses are **relative to `MEDIA_ROOT`**; the absolute
path never leaves the server.

| Method | Route | Behaviour |
|---|---|---|
| `GET` | `/api/browse?path=` | Immediate subdirectories of `path`, with a video count per directory. Used by the tree. |
| `GET` | `/api/scan?path=` | Recursive walk. Returns every video file with `{path, width, height, codec, size, duration, wouldReduce, queued}`. |
| `POST` | `/api/jobs` | Body `{paths: []}`. Creates a `waiting` row per path, snapshotting current settings. Ignores paths already present. Returns the created rows. |
| `GET` | `/api/jobs` | All rows, newest-first within each status. The UI polls this every 2s. |
| `DELETE` | `/api/jobs/:id` | Deletes a `waiting` row. 409 on any other status. |
| `POST` | `/api/jobs/:id/requeue` | Resets a `failed` or `skipped` row to `waiting`, clearing `error` and `new_size`. 409 otherwise. |
| `GET` | `/api/settings` | Current settings. |
| `PUT` | `/api/settings` | Validate and replace. |

### Path safety

Every path arriving from the client goes through one function in `media.js`:

```js
resolveSafe(rel)  // join to MEDIA_ROOT, realpath, assert the result is inside
                  // the realpath of MEDIA_ROOT, throw otherwise
```

`realpath` after joining is what closes the symlink escape — a plain string-prefix
check on the joined path would let a symlink inside `MEDIA_ROOT` point anywhere.
Nothing in the codebase touches a client-supplied path without going through it.

## Scanning

`GET /api/scan` walks the tree under the given directory and, for each file whose
extension is in `mkv mp4 avi mov wmv flv m4v mpg mpeg ts m2ts webm`, runs:

```
ffprobe -v error -select_streams v:0 \
        -show_entries stream=codec_name,width,height \
        -show_entries format=duration -of json <file>
```

JSON rather than the script's CSV, because CSV field order is fixed by ffprobe rather
than by the request and is easy to get subtly wrong.

Excluded from the walk: anything under `MEDIA_ROOT/.trash`, and in-progress temp
files matching `.*.tmp.*`.

Files that fail to probe, or that report no video stream, are returned with
`wouldReduce: false` and a `probeError` flag so the UI can show them greyed out
rather than silently dropping them.

`wouldReduce` is `min(width, height) > targetShortSide`. It is computed **client-side**
from the returned dimensions so that changing the target resolution in the settings
panel re-ticks the list without a re-scan. The server also computes it, for the
default state of a fresh scan.

Probing a large tree is slow, so the scan runs ffprobe with a small concurrency
limit (4) and streams nothing — the client shows a scanning state until the whole
response lands. A tree of a few thousand files takes seconds; this is acceptable for
a tool used a handful of times a week.

## Worker

A single async loop, started once at boot. It takes the lowest-`id` `waiting` job,
sets it `processing`, and runs one encode. When the queue is empty it sleeps 2s and
looks again. There is no start/stop control — adding files is the start signal.

### Target dimensions

Preserve aspect ratio, scale the shorter side to the target, round both sides down
to even numbers (hardware encoders require it):

```
if width >= height:  new_h = target;  new_w = even(width  * target / height)
else:                new_w = target;  new_h = even(height * target / width)
```

### Audio and mapping

Matching the script: probe `a:0`; if it is already `aac`, `-c:a copy`, otherwise
`-c:a aac -b:a <audioBitrate> -ac 2`.

For `mp4`: `-map 0:v:0 -map 0:a? -sn -movflags +faststart -tag:v hvc1` — subtitles are
dropped, which is the documented cost of choosing mp4.
For `mkv`: `-map 0 -c:s copy` — keeps subtitle and extra streams.

### Encode commands

Temp file is `<dir>/.<name>.tmp.<container>`, final is `<dir>/<name>.<container>`.

VAAPI:
```
ffmpeg -hide_banner -loglevel error -nostdin -y -progress pipe:1 -nostats \
  -vaapi_device <vaapiDevice> -i <src> \
  -vf format=nv12,hwupload,scale_vaapi=w=<W>:h=<H> \
  -c:v hevc_vaapi -rc_mode CQP -qp <quality> \
  <audioOpts> <mapOpts> <tmp>
```

QSV:
```
ffmpeg -hide_banner -loglevel error -nostdin -y -progress pipe:1 -nostats \
  -init_hw_device qsv=hw -filter_hw_device hw -i <src> \
  -vf format=nv12,hwupload=extra_hw_frames=64,vpp_qsv=w=<W>:h=<H> \
  -c:v hevc_qsv -global_quality <quality> \
  <audioOpts> <mapOpts> <tmp>
```

Software (no `/dev/dri`, or hardware encode unavailable):
```
ffmpeg -hide_banner -loglevel error -nostdin -y -progress pipe:1 -nostats \
  -i <src> -vf scale=<W>:<H> \
  -c:v libx265 -crf <quality> -preset medium \
  <audioOpts> <mapOpts> <tmp>
```

Arguments are passed as an array to `spawn` — never through a shell — so filenames
with spaces, quotes, or `$` are safe by construction.

### Progress

`-progress pipe:1` writes `key=value` lines to stdout. The worker reads `out_time_us`
and divides by the job's `duration` for a percentage, and keeps the last `bitrate`
value. Writes are throttled to at most one DB update per second. `stderr` is
accumulated with only the last 4KB retained; on failure that tail becomes `error`.

### Verification

The original is not touched until all of these hold, mirroring the script:

1. ffmpeg exit code is 0
2. the temp file exists and is non-empty
3. `|duration(temp) - duration(original)| <= 3` seconds
4. `size(temp) < size(original)`

Failing 1–3 → `failed`, temp deleted, original untouched.
Failing 4 → `skipped`, temp deleted, original untouched.

### Replacing the original

On success, in this order:

1. `trash = MEDIA_ROOT/.trash/<path relative to MEDIA_ROOT>`; create its parent
2. move the original to `trash` — `rename`, falling back to copy-then-unlink on
   `EXDEV` if `.trash` somehow lands on a different mount
3. `rename(temp, final)`
4. record `new_size`, `final_path`, `trash_path`, `finished_at`, status `done`

If step 3 fails, the original is restored from trash and the job is marked `failed`.
Nothing empties `.trash` — that is a deliberate manual `rm` by the user.

Note that `final` differs from the source path when the container changes (an `.mkv`
source with `container: "mp4"` produces a `.mp4`), which is exactly why the original
is moved out of the way rather than overwritten.

### Restart recovery

On boot, before the worker starts: every row in `processing` is reset to `waiting`
with `progress` zeroed, and its temp file is deleted if present. An encode killed
mid-write leaves only a temp file, so the source is always intact and the job is
safe to retry from scratch.

## Frontend

Alpine.js — the single distribution file, vendored into `public/` rather than loaded
from a CDN, for the same offline reason as Tailwind below — driving two views.

### Tailwind

`src/app.css` declares the Cybernetic Core tokens from `docs/design/design.md` in a
`@theme` block — the surface ramp, `primary` cyan `#00f2ff`, magenta secondary, toxic
green tertiary, Inter and JetBrains Mono, and the 4px spacing rhythm. Built with:

```
npx @tailwindcss/cli -i src/app.css -o public/app.css --minify
```

`npm run css` in dev with `--watch`; one `RUN` line in the Dockerfile for the image.
Not the `cdn.tailwindcss.com` script the mockups use — that requires internet on every
page load, which a LAN container should not depend on. Fonts come from Google Fonts
with `ui-sans-serif` / `ui-monospace` fallbacks; if offline rendering matters later,
vendoring the woff2 files is a drop-in change.

Visual language follows the design doc: zero border radius, translucent surfaces with
`backdrop-blur`, neon 1px borders plus glow for elevation, monospace for every path,
size, and status readout, `[ BRACKETED ]` status pills.

### `#/browse` — FILE_TERMINAL

Modelled on `docs/design/stitch_cyberdeck_file_explorer/file_selector_desktop`.

Left pane: directory tree under `MEDIA_ROOT`, lazily expanded via `/api/browse`.
Selecting a directory triggers `/api/scan` on it.

Right pane: one card per video with filename, `WxH`, codec, and size. Cards whose
shorter side exceeds the target are ticked by default; the rest render dimmed with an
`[ ALREADY_<N>P ]` tag and start unticked, but remain tickable. Files already in the
queue show `[ QUEUED ]` and are disabled. A breadcrumb across the top uses `/`
separators in monospace.

Sticky bottom bar: `N FILES SELECTED` / `TOTAL_SIZE: …` and the `ADD_TO_PIPELINE`
button, which POSTs the selection and switches to the queue view.

### `#/queue` — DATA_PROCESSOR

Modelled on `docs/design/stitch_cyberdeck_file_explorer/data_processor_desktop`.

- **PENDING_QUEUE** — waiting jobs, filename over `size | WxH`, each with a remove button.
- **ACTIVE_PROCESS** — the running job: filename, target encoding and dimensions, big
  percentage, the segmented "data stream" bar from the design doc, and readouts for
  time remaining (extrapolated from percent and elapsed) and current bitrate. The
  mockup's CPU_USAGE readout is dropped — ffmpeg does not report it and it is not
  worth a second data source.
- **COMPLETED_ARCHIVE** — a table of `FILENAME / ORIGINAL / COMPRESSED / SAVING`, with
  `done` rows in toxic green, `skipped` in outline grey, `failed` in error red. Failed
  rows expand to show the ffmpeg stderr tail. A footer totals bytes reclaimed.

Settings is a panel that slides over the sidebar, not a third view. The sidebar keeps
only `FILE_TERMINAL` and `DATA_PROCESSOR`.

### Polling

One `setInterval` at 2s hitting `GET /api/jobs`, only while the tab is visible
(`document.visibilitychange`). No websockets — 2s is well inside the useful resolution
for encodes that run for minutes.

## Docker

`node:24-slim`, plus `ffmpeg` and the Intel VAAPI driver from Debian (`non-free`
enabled for `intel-media-va-driver-nonfree`, as the script's own setup notes
recommend). Tailwind is built during the image build; `@tailwindcss/cli` does not ship
in the final layer.

| Env | Default | Meaning |
|---|---|---|
| `MEDIA_ROOT` | `/media` | The only directory the app can see |
| `DB_PATH` | `/data/queue.db` | SQLite file |
| `PORT` | `3000` | HTTP port |

Run:

```
docker run -d \
  --device /dev/dri:/dev/dri \
  --group-add "$(getent group render | cut -d: -f3)" \
  -v /your/media:/media \
  -v video-compressor-data:/data \
  -p 3000:3000 \
  video-compressor
```

`--group-add` is required: the container user must be in the host's `render` group
GID to open `/dev/dri/renderD128`. Without the device or the group, hardware encode
fails; the `software` encoder setting exists so the app is still useful in that case.

A `docker-compose.yml` with the same wiring ships alongside, since remembering the
`getent` incantation is exactly the kind of thing that stops a tool being used.

### Host prerequisites

Both currently unmet on this machine and needed before hardware encode works:

- `ffmpeg` is not installed (only relevant for running outside Docker)
- the user is not in the `render` group — `sudo usermod -aG render $USER`, then re-login

## Testing

One `test.js` using `node:test`, covering only the logic that can be silently wrong:

1. **Path safety** — `resolveSafe` accepts a normal relative path; rejects `../`
   traversal, an absolute path outside the root, and a symlink inside the root that
   points outside it.
2. **`wouldReduce`** at the boundary — `1280x720` at target 720 is false, `1920x1080`
   at target 720 is true, portrait `720x1280` at target 720 is false, `1920x1080` at
   target 1080 is false.
3. **`targetDims`** — aspect ratio preserved, both sides even, landscape and portrait.
4. **The verify predicate** — a table over exit code, temp size, duration delta at
   exactly ±3s and ±4s, and new-size-vs-original, asserting `done` / `skipped` /
   `failed`.

No framework, no fixtures, no HTTP-level tests. `npm test` runs it.

## Non-goals

Deliberately excluded, each cheap to add later if it turns out to matter:

- Authentication — the app is assumed to be on a trusted LAN
- Pausing or cancelling a running encode
- Parallel encodes across both render devices
- Per-job settings overrides
- Uploading files from the browser; sources are always already on the server
- Emptying `.trash` from the UI
- Any of the mockup's other screens (Dashboard, Secure Vault, Uplink Monitor)
