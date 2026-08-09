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
