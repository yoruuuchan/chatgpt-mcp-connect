#!/usr/bin/env node
/**
 * check-links.mjs — verify that every local link in the Markdown docs still resolves.
 *
 *   node scripts/check-links.mjs
 *
 * Walks every .md file in the repository, extracts the links, and checks the
 * local ones: the target must exist, spelled with exactly the case stored on
 * disk, and any #anchor must match a heading in the target file.
 *
 * Remote URLs are counted and deliberately left alone. This repo documents
 * third-party services, so a remote check would fail on rate limits, paywalls
 * and temporary outages — noise that hides the thing worth catching, which is
 * a renamed or moved file leaving dead links behind.
 *
 * No dependencies. Node 18+.
 *
 * SPDX-License-Identifier: MIT
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Rooted at the script's own location rather than the cwd, so running it from a
// subdirectory cannot quietly report success over zero files.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const REMOTE = /^[a-zA-Z][a-zA-Z\d+.\-]*:/; // http:, mailto:, tel:, data:, ...

// --------------------------------------------------------------- repo index ---
// Windows and macOS checkouts resolve paths case-insensitively, so
// fs.existsSync() cannot see a wrong-case link: it happily resolves
// ./Docs/Architecture.md in a repo that ships docs/architecture.md, while the
// Linux CI runner and GitHub itself both 404 on it. The index is therefore
// built from the names the filesystem actually reports, and every lookup
// compares the requested spelling against the real one.

const files = new Map(); // lowercase relative posix path -> real relative posix path
const dirs = new Map(); // lowercase relative posix path -> lowercase child names

(function index(dir, rel) {
  dirs.set(rel.toLowerCase(), new Set());
  files.set(rel.toLowerCase(), rel === '' ? '.' : rel);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    const childKey = childRel.toLowerCase();
    dirs.get(rel.toLowerCase()).add(entry.name.toLowerCase());
    files.set(childKey, childRel);
    if (entry.isDirectory()) index(path.join(dir, entry.name), childRel);
  }
})(ROOT, '');

const markdownFiles = [...files.values()]
  .filter((rel) => /\.md$/i.test(rel))
  .sort((a, b) => a.localeCompare(b));

// --------------------------------------------------------------------- layout ---
// Markdown constructs that are not links: fenced code blocks (sample configs
// and shell transcripts), HTML comments, and YAML frontmatter.

function frontmatterLines(source) {
  if (!source.startsWith('---')) return 0;
  const lines = source.split('\n');
  for (let i = 1; i < lines.length; i++) if (/^---\s*$/.test(lines[i])) return i + 1;
  return 0;
}

/** Blank out everything that is not Markdown content, preserving line count and offsets. */
function visibleLines(source) {
  const skip = frontmatterLines(source);
  const lines = source.split('\n');
  const out = lines.map(() => '');
  let fence = null;
  let inComment = false;
  for (let i = skip; i < lines.length; i++) {
    let line = lines[i];
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1];
      else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      continue; // the fence line itself holds no link we care about
    }
    if (fence) continue;
    if (inComment) {
      const end = line.indexOf('-->');
      if (end === -1) continue;
      line = ' '.repeat(end + 3) + line.slice(end + 3);
      inComment = false;
    }
    line = line.replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => (m.endsWith('-->') ? ' '.repeat(m.length) : ''));
    inComment = /<!--/.test(line);
    // Blank out code spans in place, so [`path`](./target) still parses as a
    // link while `](./not-a-link)` inside a span does not.
    out[i] = line.replace(/(`+)(.*?)\1/g, (m) => ' '.repeat(m.length));
  }
  return out;
}

// ---------------------------------------------------------------- link syntax ---

/** `[ref]: ./target` and `[ref]: <./target with space>`, keyed by lowercased label. */
function referenceDefinitions(source) {
  const defs = new Map();
  const pattern = /^ {0,3}\[([^\]]+)\]:\s*(?:<([^<>\n]*)>|(\S+))(?:\s+(?:"[^"]*"|'[^']*'))?\s*$/gm;
  for (const m of source.matchAll(pattern)) defs.set(m[1].toLowerCase(), m[2] ?? m[3]);
  return defs;
}

/** Every link target in one line of visible Markdown, in order. */
function* targetsIn(line, definitions) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== ']' || line[i + 1] !== '(') continue;

    // Inline link: ](<target with space> "title") or ](target "title")
    let j = i + 2;
    let target;
    if (line[j] === '<') {
      const end = line.indexOf('>', j + 1);
      if (end === -1) continue;
      target = line.slice(j + 1, end);
      i = end;
    } else {
      const start = j;
      let depth = 0;
      while (j < line.length) {
        const c = line[j];
        if (c === '\\') j += 2;
        else if (c === '(') { depth++; j++; }
        else if (c === ')') { if (depth === 0) break; depth--; j++; }
        else if (depth === 0 && /\s/.test(c)) break;
        else j++;
      }
      target = line.slice(start, j);
      i = j - 1;
    }
    yield target;
  }

  // Reference-style links: [text][ref], [text][] and [ref].
  for (const m of line.matchAll(/\]\[([^\]]*)\]/g)) {
    const label = m[1];
    if (label && definitions.has(label.toLowerCase())) yield definitions.get(label.toLowerCase());
  }
  // HTML attributes.
  for (const m of line.matchAll(/<[a-zA-Z][^>]*\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    yield m[1] ?? m[2] ?? m[3];
  }
}

// ------------------------------------------------------------------- anchors ---
// GitHub renders Markdown with a slugger that lowercases the heading, drops
// punctuation, symbols and control characters, keeps letters, numbers, marks,
// '-' and '_', and turns every remaining space into '-'. Duplicate slugs take a
// -1, -2 suffix. CJK characters are letters, so Chinese headings keep theirs.
// Verified against the rendered output of every Markdown file in this repo.

const SLUG_DROP = /[^\p{L}\p{N}\p{M}\p{Z}\-_\t]/gu;

function slug(text) {
  return text
    .trim()
    .toLowerCase()
    .replace(SLUG_DROP, '')
    .replace(/\s/g, '-');
}

/** Inline Markdown that renders as plain text inside a heading. */
function inlineText(text) {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/\*\*|__|\*|~~/g, '');
}

const anchorsByFile = new Map();

/** The set of valid #anchor names for one Markdown file. */
function anchorsOf(rel) {
  if (anchorsByFile.has(rel)) return anchorsByFile.get(rel);
  const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const set = new Set();
  const counts = new Map();
  let fence = null;
  const lines = source.split('\n');
  for (let i = frontmatterLines(source); i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1];
      else if (fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;

    // [\s\S] instead of . so a CRLF checkout's trailing \r is consumed by the
    // match instead of being dropped by the capture (where it would leak into
    // the slug and break every anchor on Windows).
    const heading = /^ {0,3}#{1,6}\s+([\s\S]*)$/.exec(line);
    if (heading) {
      const base = slug(inlineText(heading[1].replace(/\s+#+\s*$/, '')));
      const seen = counts.get(base) ?? 0;
      counts.set(base, seen + 1);
      set.add(seen === 0 ? base : `${base}-${seen}`);
    }
    // Explicit HTML anchors are valid targets as well.
    for (const m of line.matchAll(/<a\b[^>]*\s(?:id|name)\s*=\s*["']([^"']+)["']/gi)) set.add(m[1]);
  }
  anchorsByFile.set(rel, set);
  return set;
}

function decoded(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ checking ---

const problems = [];
const stats = { local: 0, anchors: 0, skipped: 0 };

for (const rel of markdownFiles) {
  const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const definitions = referenceDefinitions(source);
  const lines = visibleLines(source);
  const base = frontmatterLines(source);
  const own = anchorsOf(rel);
  const dir = path.posix.dirname(rel);

  for (let i = base; i < lines.length; i++) {
    for (const raw of targetsIn(lines[i], definitions)) {
      const target = raw.trim();
      if (target === '') {
        problems.push({ rel, line: i + 1, raw, why: 'link has no target' });
        continue;
      }
      if (REMOTE.test(target) || target.startsWith('//')) {
        stats.skipped++;
        continue;
      }

      const hash = target.indexOf('#');
      const pathPart = hash === -1 ? target : target.slice(0, hash);
      const fragment = hash === -1 ? null : target.slice(hash + 1);
      const query = pathPart.indexOf('?');
      if (query !== -1) stats.skipped++;

      const decodedPath = decoded(query === -1 ? pathPart : pathPart.slice(0, query));
      if (decodedPath === null) {
        problems.push({ rel, line: i + 1, raw, why: 'link target is not valid percent-encoding' });
        continue;
      }

      if (decodedPath.startsWith('/')) {
        // Repo-root-relative links point at github.com, not at this repo, and
        // this repo documents URL paths like /mcp all over. Leave them alone.
        stats.skipped++;
        continue;
      }

      if (decodedPath === '') {
        stats.anchors++;
        const name = decoded(fragment) ?? fragment;
        if (!own.has(name)) problems.push({ rel, line: i + 1, raw, why: `no heading or anchor "${fragment}" in this file` });
        continue;
      }

      // path.posix.normalize keeps a trailing slash, which would make every
      // directory link miss the index, so strip it before resolving.
      const joined = `${dir === '.' ? '' : dir + '/'}${decodedPath}`.replace(/\/+$/, '');
      const requested = path.posix.normalize(joined === '' ? '.' : joined);
      if (requested.startsWith('..')) {
        problems.push({ rel, line: i + 1, raw, why: 'link points outside the repository' });
        continue;
      }

      const key = (requested === '.' ? '' : requested).toLowerCase();
      stats.local++;
      const real = files.get(key);
      if (real === undefined) {
        const hint = nearestExisting(requested);
        problems.push({ rel, line: i + 1, raw, why: `target does not exist: ${requested}${hint ? ` (did you mean ${hint}?)` : ''}` });
        continue;
      }
      if (real !== requested && requested !== '.') {
        problems.push({ rel, line: i + 1, raw, why: `wrong case: link says ${requested}, repo has ${real}` });
        continue;
      }

      // GitHub serves a directory link only when the directory has a README or
      // an index file to render; otherwise it 404s like a missing file.
      const children = dirs.get(key);
      if (children && !children.has('readme.md') && !children.has('index.md')) {
        problems.push({ rel, line: i + 1, raw, why: `directory ${real} has no README.md or index.md, so GitHub cannot render it` });
        continue;
      }

      if (fragment !== null && /\.md$/i.test(real)) {
        stats.anchors++;
        const name = decoded(fragment) ?? fragment;
        if (!anchorsOf(real).has(name)) {
          problems.push({ rel, line: i + 1, raw, why: `no heading or anchor "${fragment}" in ${real}` });
        }
      }
    }
  }
}

/** The real spelling of the deepest path component that does exist, if it differs. */
function nearestExisting(requested) {
  const segments = requested.split('/');
  for (let i = segments.length; i > 0; i--) {
    const partial = segments.slice(0, i).join('/');
    const real = files.get(partial.toLowerCase());
    if (real !== undefined && real !== partial) return real;
  }
  return null;
}

// -------------------------------------------------------------------- report ---

const summary =
  `${markdownFiles.length} Markdown files, ${stats.local} local targets, ` +
  `${stats.anchors} anchors checked, ${stats.skipped} remote links left unchecked`;

if (problems.length) {
  console.error(`\n${problems.length} broken link${problems.length === 1 ? '' : 's'}:\n`);
  let lastFile = null;
  for (const p of problems) {
    if (p.rel !== lastFile) console.error(`  ${p.rel}`);
    lastFile = p.rel;
    console.error(`    line ${String(p.line).padStart(4)}  ${p.raw}`);
    console.error(`              ${p.why}\n`);
  }
  console.error(`Checked ${summary}.\n`);
  process.exit(1);
}

console.log(`All links resolve. ${summary}.`);
