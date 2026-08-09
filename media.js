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
