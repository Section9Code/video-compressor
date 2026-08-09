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
