import { lstat, readdir, unlink } from 'node:fs/promises';
import { join, posix, relative, resolve, sep } from 'node:path';

const mapAssetPrefix = /^\/assets\/maps\/[^/]+\//i;
const receiptFilename = /\/(?:[^/]+-report|source-upgrade)\.json\/?$/i;

/** Receipts describe conversion work, not resources consumed by the player. */
export function isPrivateAssetReceipt(path) {
  const normalized = posix.normalize('/' + path.replaceAll('\\', '/'));
  return mapAssetPrefix.test(normalized) && receiptFilename.test(normalized);
}

/** Run only on an owned build output, never on borrowed native-data links. */
export async function removePrivateAssetReceipts(directory) {
  const root = resolve(directory), maps = join(root, 'assets', 'maps');
  const removed = [];
  let info;
  try { info = await lstat(maps); }
  catch (error) { if (error.code === 'ENOENT') return removed; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Cannot sanitize linked or non-directory map output');
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const key = '/' + relative(root, path).split(sep).join('/');
      if (isPrivateAssetReceipt(key)) {
        if (!entry.isFile() && !entry.isSymbolicLink()) throw Error(`Conversion receipt is not a regular output file: ${key}`);
        await unlink(path);
        removed.push(key);
      } else if (entry.isSymbolicLink()) {
        throw Error(`Cannot sanitize borrowed map output: ${key}`);
      } else if (entry.isDirectory()) {
        await walk(path);
      }
    }
  }
  await walk(maps);
  return removed;
}

/** Vite dev/preview may read linked source data; deny without modifying it. */
export function privateAssetReceiptMiddleware(request, response, next) {
  let path;
  try {
    const target = request.url ?? '/';
    const relative = target.startsWith('//') ? target.replace(/^\/+/, '/') : target;
    path = posix.normalize(decodeURIComponent(new URL(relative, 'http://localhost').pathname).replaceAll('\\', '/'));
  } catch { return next(); }
  // Public-directory and /@fs aliases can omit the canonical asset prefix.
  if (!receiptFilename.test(path)) return next();
  response.statusCode = 404;
  response.setHeader('Cache-Control', 'no-store');
  response.end();
}
