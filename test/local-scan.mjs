/* Development helper: run the scanner against a local checkout of HaTi rather
   than a downloaded tarball, so the parsers can be iterated on without
   spending a GitHub request per attempt. Not used in production.

   Usage: node test/local-scan.mjs /path/to/mkataba-clm [panel] */

import fs from 'node:fs';
import path from 'node:path';
import { buildScan } from '../lib/scan.mjs';

const root = process.argv[2];
if (!root) { console.error('usage: node test/local-scan.mjs /path/to/mkataba-clm [panel]'); process.exit(1); }

function walk(dir, base = '', out = new Map()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const abs = path.join(dir, entry.name);
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(abs, rel, out);
    else out.set(rel, fs.readFileSync(abs));
  }
  return out;
}

const files = walk(root);
const payload = buildScan({ files, commits: null, repo: 'local', ref: 'working-tree', requestCount: 0 });

const panel = process.argv[3];
const view = panel ? payload[panel] : payload;
console.log(JSON.stringify(view, null, 2));
