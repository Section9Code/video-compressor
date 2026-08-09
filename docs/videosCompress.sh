#!/usr/bin/env bash
#
# reencode-720p.sh — Recursively find videos above 720p and re-encode them
# to 720p HEVC (H.265) using Intel hardware encoding (VAAPI or QSV).
# Originals are REPLACED after a successful, sanity-checked encode.
#
# Usage:
#   ./reencode-720p.sh /path/to/videos            # normal run
#   ./reencode-720p.sh /path/to/videos --dry-run  # show what would happen
#
# Safe for cron/systemd: uses a lock file so overlapping runs are impossible.
#
# Requirements (Ubuntu):
#   sudo apt install ffmpeg intel-media-va-driver-nonfree vainfo
#   Your user must be in the 'render' group:  sudo usermod -aG render $USER
#   Verify hardware encode support with:      vainfo | grep -i hevc
#
set -u

# ============================ CONFIGURATION =================================

ENCODER="vaapi"              # "vaapi" (recommended on Ubuntu) or "qsv"
QUALITY=25                   # Lower = better quality / bigger file. 23-28 sensible.
OUTPUT_EXT="mp4"             # "mp4" = max compatibility (subtitles dropped)
                             # "mkv" = keeps subtitle/extra streams
AUDIO_BITRATE="128k"         # Used when audio needs transcoding to AAC
VAAPI_DEVICE="/dev/dri/renderD128"
TARGET_SHORT_SIDE=720        # Videos whose shorter side is <= this are skipped

LOG_FILE="${HOME}/reencode-720p.log"
SKIP_LIST="${HOME}/.reencode-720p-skip.list"   # files judged not worth replacing
LOCK_FILE="/tmp/reencode-720p.lock"

VIDEO_EXTENSIONS=(mkv mp4 avi mov wmv flv m4v mpg mpeg ts m2ts webm)

# ============================================================================

DRY_RUN=0
SOURCE_DIR=""

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        *)         SOURCE_DIR="$arg" ;;
    esac
done

if [[ -z "$SOURCE_DIR" || ! -d "$SOURCE_DIR" ]]; then
    echo "Usage: $0 /path/to/video/folder [--dry-run]" >&2
    exit 1
fi

log() {
    local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
    echo "$msg"
    echo "$msg" >> "$LOG_FILE"
}

# --- Prevent overlapping scheduled runs -------------------------------------
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
    echo "Another instance is already running. Exiting." >&2
    exit 0
fi

command -v ffmpeg  >/dev/null || { echo "ffmpeg not found" >&2; exit 1; }
command -v ffprobe >/dev/null || { echo "ffprobe not found" >&2; exit 1; }
touch "$SKIP_LIST"

# --- Helpers -----------------------------------------------------------------

probe() {  # probe <file> <entries>  -> csv values
    ffprobe -v error -select_streams v:0 \
        -show_entries "stream=$2" -of csv=p=0 "$1" 2>/dev/null
}

get_duration() {
    ffprobe -v error -show_entries format=duration -of csv=p=0 "$1" 2>/dev/null \
        | cut -d. -f1
}

even() {  # round to nearest even number (encoders require even dimensions)
    echo $(( ($1 / 2) * 2 ))
}

# --- Build the find expression for all video extensions ----------------------
FIND_ARGS=()
for ext in "${VIDEO_EXTENSIONS[@]}"; do
    FIND_ARGS+=(-iname "*.${ext}" -o)
done
unset 'FIND_ARGS[${#FIND_ARGS[@]}-1]'   # drop trailing -o

TOTAL_SAVED=0
PROCESSED=0
SKIPPED=0
FAILED=0

log "=== Run started: scanning '$SOURCE_DIR' (encoder: $ENCODER, dry-run: $DRY_RUN) ==="

while IFS= read -r -d '' file; do

    # Skip our own in-progress temp files
    [[ "$(basename "$file")" == .*.tmp.* ]] && continue

    # Skip files previously judged not worth re-encoding
    if grep -qxF "$file" "$SKIP_LIST"; then
        continue
    fi

    # --- Probe resolution & codec -------------------------------------------
    # NOTE: ffprobe outputs fields in its own fixed order (codec_name,width,height),
    # regardless of the order requested in -show_entries.
    dims=$(probe "$file" "codec_name,width,height")
    if [[ -z "$dims" ]]; then
        log "WARN  No video stream / unreadable: $file"
        continue
    fi
    codec=$(cut -d, -f1 <<< "$dims")
    width=$(cut -d, -f2 <<< "$dims")
    height=$(cut -d, -f3 <<< "$dims")

    if ! [[ "$width" =~ ^[0-9]+$ && "$height" =~ ^[0-9]+$ ]]; then
        log "WARN  Could not read dimensions: $file"
        continue
    fi

    # Shorter side handles portrait videos correctly
    short_side=$(( width < height ? width : height ))
    if (( short_side <= TARGET_SHORT_SIDE )); then
        SKIPPED=$((SKIPPED+1))
        continue
    fi

    # --- Compute target dimensions (preserve aspect ratio) ------------------
    if (( width >= height )); then
        new_h=$TARGET_SHORT_SIDE
        new_w=$(even $(( width * TARGET_SHORT_SIDE / height )))
    else
        new_w=$TARGET_SHORT_SIDE
        new_h=$(even $(( height * TARGET_SHORT_SIDE / width )))
    fi

    orig_size=$(stat -c%s "$file")
    orig_size_mb=$(( orig_size / 1024 / 1024 ))

    if (( DRY_RUN )); then
        log "DRY   ${width}x${height} ($codec, ${orig_size_mb}MB) -> ${new_w}x${new_h} hevc : $file"
        PROCESSED=$((PROCESSED+1))
        continue
    fi

    # --- Audio: copy if already AAC, otherwise transcode ---------------------
    audio_codec=$(ffprobe -v error -select_streams a:0 \
        -show_entries stream=codec_name -of csv=p=0 "$file" 2>/dev/null)
    if [[ "$audio_codec" == "aac" ]]; then
        AUDIO_OPTS=(-c:a copy)
    else
        AUDIO_OPTS=(-c:a aac -b:a "$AUDIO_BITRATE" -ac 2)
    fi

    # --- Container-specific stream mapping -----------------------------------
    if [[ "$OUTPUT_EXT" == "mp4" ]]; then
        MAP_OPTS=(-map 0:v:0 -map '0:a?' -sn -movflags +faststart -tag:v hvc1)
    else
        MAP_OPTS=(-map 0 -c:s copy)
    fi

    dir=$(dirname "$file")
    base=$(basename "$file")
    name="${base%.*}"
    tmp_file="${dir}/.${name}.tmp.${OUTPUT_EXT}"
    final_file="${dir}/${name}.${OUTPUT_EXT}"

    log "START ${width}x${height} ($codec, ${orig_size_mb}MB) -> ${new_w}x${new_h}: $file"

    # --- Encode ---------------------------------------------------------------
    if [[ "$ENCODER" == "vaapi" ]]; then
        ffmpeg -hide_banner -loglevel error -y -nostdin \
            -vaapi_device "$VAAPI_DEVICE" \
            -i "$file" \
            -vf "format=nv12,hwupload,scale_vaapi=w=${new_w}:h=${new_h}" \
            -c:v hevc_vaapi -rc_mode CQP -qp "$QUALITY" \
            "${AUDIO_OPTS[@]}" "${MAP_OPTS[@]}" \
            "$tmp_file" </dev/null
    else
        ffmpeg -hide_banner -loglevel error -y -nostdin \
            -init_hw_device qsv=hw -filter_hw_device hw \
            -i "$file" \
            -vf "format=nv12,hwupload=extra_hw_frames=64,vpp_qsv=w=${new_w}:h=${new_h}" \
            -c:v hevc_qsv -global_quality "$QUALITY" \
            "${AUDIO_OPTS[@]}" "${MAP_OPTS[@]}" \
            "$tmp_file" </dev/null
    fi
    encode_status=$?

    # --- Verify before touching the original ----------------------------------
    if (( encode_status != 0 )) || [[ ! -s "$tmp_file" ]]; then
        log "FAIL  Encode error (exit $encode_status): $file"
        rm -f "$tmp_file"
        FAILED=$((FAILED+1))
        continue
    fi

    orig_dur=$(get_duration "$file")
    new_dur=$(get_duration "$tmp_file")
    if [[ -z "$orig_dur" || -z "$new_dur" ]] || \
       (( new_dur < orig_dur - 3 || new_dur > orig_dur + 3 )); then
        log "FAIL  Duration mismatch (orig ${orig_dur}s vs new ${new_dur}s): $file"
        rm -f "$tmp_file"
        FAILED=$((FAILED+1))
        continue
    fi

    new_size=$(stat -c%s "$tmp_file")
    if (( new_size >= orig_size )); then
        log "SKIP  New file not smaller (${orig_size_mb}MB -> $((new_size/1024/1024))MB), keeping original: $file"
        rm -f "$tmp_file"
        echo "$file" >> "$SKIP_LIST"
        SKIPPED=$((SKIPPED+1))
        continue
    fi

    # --- Replace original -------------------------------------------------------
    rm -f "$file"
    mv "$tmp_file" "$final_file"

    saved_mb=$(( (orig_size - new_size) / 1024 / 1024 ))
    TOTAL_SAVED=$((TOTAL_SAVED + saved_mb))
    PROCESSED=$((PROCESSED+1))
    log "DONE  Saved ${saved_mb}MB (${orig_size_mb}MB -> $((new_size/1024/1024))MB): $final_file"

done < <(find "$SOURCE_DIR" -type f \( "${FIND_ARGS[@]}" \) -print0)

log "=== Run complete: $PROCESSED encoded, $SKIPPED skipped, $FAILED failed, ~${TOTAL_SAVED}MB saved ==="
