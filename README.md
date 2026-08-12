# video-compressor

A web UI over a server-side ffmpeg queue. Point it at a directory of videos, pick a
target resolution, and it re-encodes anything larger to HEVC using Intel hardware
acceleration. Originals are moved to `.trash` inside the media root, deleted on a schedule.

![](/docs/images/example-screen.png)

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
sudo apt install ffmpeg intel-media-va-driver-non-free vainfo
sudo usermod -aG render "$USER"     # then log out and back in
npm install && npm run build
MEDIA_ROOT=/path/to/your/videos DB_PATH=./queue.db npm start
```

`MEDIA_ROOT` must be an existing directory — the app resolves it at startup and
exits with a message rather than starting against a path that isn't there. Both
`apt` lines are required: without ffmpeg every file scans as `UNREADABLE`, and
without the `render` group ffmpeg cannot open `/dev/dri/renderD128`. Docker needs
neither, since the image installs ffmpeg itself and takes the render group as a
numeric GID.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `MEDIA_ROOT` | `/media` | The only directory the app can see or touch |
| `DB_PATH` | `/data/queue.db` | SQLite queue file |
| `PORT` | `3000` | HTTP port |
| `TRASH_ROOT` | `<MEDIA_ROOT>/.trash` | Where replaced originals are kept until purged |
| `TZ` | `UTC` | Timezone the encode schedule window is evaluated in |

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
   new file takes its place.
5. 24 hours later the original is permanently deleted, unless you change that.

Restarting the container is safe: a job interrupted mid-encode is reset to waiting and
its temp file removed. The source is never modified until verification passes.

## Trash retention

Keeping every original forever means the tool costs disk rather than saving it — the
saving only lands when `.trash` is emptied. So originals are deleted automatically
after a window long enough to check the re-encoded file first.

`DELETE_ORIGINALS_AFTER` under ENCODE_PARAMS: **24 hours** by default, or 48 hours,
7 days, or **Never** if you would rather empty `.trash` yourself. Each completed row
in COMPLETED_ARCHIVE shows its deadline (`ORIGINAL DELETED IN 18h`) so it is visible
before it passes, and reads `ORIGINAL DELETED` afterwards.

Originals go to `TRASH_ROOT`, which defaults to `.trash` inside the media root. Set it
if your media root is not writable at its top level, or if you want the originals on
different storage — mount it as `TRASH_DIR` in `.env`. The directory must be writable
by uid 1000; the server checks at startup and refuses to start with a clear message
rather than failing later, after an encode has already run. A trash root on a different
filesystem works, but each swap becomes a full copy rather than a rename.

Only files this app trashed are ever removed. Anything else under `.trash` — files you
moved there yourself, or leftovers after the database is reset — is left alone, and
`Never` disables the sweep entirely.

The clock comes from the job record, not the file's timestamp: `rename` preserves
mtime, so a file trashed today can carry a years-old mtime, and an age-based sweep
would delete it immediately rather than after the window.

## Scheduling

By default the queue drains as soon as you add to it. Under ENCODE_PARAMS you can
restrict encoding to a nightly window — 02:00 to 06:00, say. Windows that wrap
midnight (22:00 → 06:00) work.

The window only gates *starting* a file. If an encode is running when the window
closes it finishes normally; the worker simply does not pick up the next one. While
the queue is held the DATA_PROCESSOR view says so.

The window is evaluated in the server's local timezone, so set `TZ` in `.env`.

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
