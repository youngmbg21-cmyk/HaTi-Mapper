/* HaTi-Mapper — a small tar reader.
 *
 * We download the whole HaTi repository as one gzipped tarball rather than
 * walking GitHub's contents API file by file, because that would be hundreds
 * of requests per scan. Unpacking needs a tar reader; pulling in a package for
 * it would be more dependency than the job deserves, so this is it. Node's
 * zlib does the gunzip; the ~90 lines below do the tar.
 *
 * Handles the parts of the format GitHub's tarballs actually use: ustar with
 * the `prefix` field, GNU long names ('L'), and pax extended headers ('x'),
 * which carry the path when it is too long for the 100-byte name field.
 */

const BLOCK = 512;

const str = (buf, off, len) => {
  const slice = buf.subarray(off, off + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8');
};

// Sizes are octal, space/NUL padded. GNU also has a base-256 form for very
// large files, flagged by the high bit — no file in a source repo needs it,
// but reading it costs three lines and avoids a silent misparse.
function readSize(buf, off, len) {
  if (buf[off] & 0x80) {
    let n = 0;
    for (let i = off + 1; i < off + len; i++) n = n * 256 + buf[i];
    return n;
  }
  const s = str(buf, off, len).trim();
  return s ? parseInt(s, 8) || 0 : 0;
}

/* Parse a decompressed tar buffer into a Map of path -> Buffer.
   Only regular files are kept; directories, symlinks and metadata entries are
   consumed and dropped. */
export function untar(buf) {
  const files = new Map();
  let pos = 0;
  let longName = null;   // pending GNU 'L' name for the next entry
  let paxPath = null;    // pending pax 'path=' for the next entry

  while (pos + BLOCK <= buf.length) {
    const head = buf.subarray(pos, pos + BLOCK);

    // Two consecutive zero blocks end the archive; one is enough to stop on.
    if (head.every(b => b === 0)) break;

    const size = readSize(head, 124, 12);
    const type = String.fromCharCode(head[156]) || '0';
    const dataStart = pos + BLOCK;
    const dataEnd = dataStart + size;
    const next = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (dataEnd > buf.length) break; // truncated archive — stop rather than throw

    if (type === 'L') {
      // GNU long name: this entry's *data* is the next entry's path.
      longName = buf.subarray(dataStart, dataEnd).toString('utf8').replace(/\0+$/, '');
    } else if (type === 'x' || type === 'X' || type === 'g') {
      // pax extended header: "<len> path=<value>\n" records.
      const text = buf.subarray(dataStart, dataEnd).toString('utf8');
      const m = text.match(/\d+ path=([^\n]*)\n/);
      if (m && type !== 'g') paxPath = m[1];
    } else if (type === '0' || type === '\0' || type === '7') {
      // Regular file. Precedence: pax > GNU long name > name/prefix fields.
      let name = paxPath || longName;
      if (!name) {
        const base = str(head, 0, 100);
        const prefix = str(head, 345, 155);
        name = prefix ? prefix + '/' + base : base;
      }
      files.set(name, buf.subarray(dataStart, dataEnd));
      longName = null; paxPath = null;
    } else {
      // Directory, symlink, hardlink, device — nothing we need.
      longName = null; paxPath = null;
    }

    pos = next;
  }

  return files;
}

/* GitHub tarballs nest everything under one generated top directory
   ("owner-repo-<sha>/"). Strip it so paths read as repository paths, and hand
   the stripped name back too — the sha in it is the version of everything
   inside, which the caller would otherwise spend another request asking for. */
export function stripRoot(files) {
  const out = new Map();
  let root = null;
  for (const key of files.keys()) {
    const slash = key.indexOf('/');
    if (slash === -1) { root = null; break; }
    const head = key.slice(0, slash);
    if (root === null) root = head;
    else if (root !== head) { root = null; break; }
  }
  if (!root) return { files, root: null };
  for (const [key, val] of files) out.set(key.slice(root.length + 1), val);
  return { files: out, root };
}
