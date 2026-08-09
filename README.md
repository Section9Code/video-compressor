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
sudo apt install ffmpeg intel-media-va-driver-non-free vainfo
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
   new file takes its place. Nothing ever empties `.trash` — that is a manual
   `rm -rf` when you are satisfied.

Restarting the container is safe: a job interrupted mid-encode is reset to waiting and
its temp file removed. The source is never modified until verification passes.

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
