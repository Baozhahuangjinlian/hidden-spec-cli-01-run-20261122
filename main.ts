// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's text as lines, its line break, and whether it ends with one (SPEC.md section 3). */
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const noTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const noEdge = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => (s.match(/^[ \t]*/) ?? [''])[0]!;

/** Two lines equal at one matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return noTrail(a) === noTrail(b);
  return noEdge(a) === noEdge(b);
}

function occurrencesAt(lines: string[], old: string[], tier: number, from: number): number[] {
  const found: number[] = [];
  for (let i = from; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < old.length; k++) {
      if (!lineEq(lines[i + k]!, old[k]!, tier)) { ok = false; break; }
    }
    if (ok) found.push(i);
  }
  return found;
}

/** The first tier at which old occurs at or after from, with its positions. */
function firstTierWith(lines: string[], old: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrencesAt(lines, old, t, from);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

/** One line of a hunk or chunk: in both old and new (ctx), only old (old), only new (new). */
interface Op {
  k: 'ctx' | 'old' | 'new';
  t: string;
}

const opsOld = (ops: Op[]): string[] => ops.filter((o) => o.k !== 'new').map((o) => o.t);

/**
 * The lines that replace a matched run: context lines are the file's own matched lines,
 * new lines are written as they are, except at tier 2 where each is re-indented from
 * the old lines' leading whitespace to the file's (SPEC.md section 5).
 */
function buildReplacement(ops: Op[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  let pLead = '';
  let fLead = '';
  if (tier === 2) {
    const firstOld = ops.find((o) => o.k !== 'new');
    pLead = firstOld === undefined ? '' : leadWs(firstOld.t);
    fLead = leadWs(fileLines[pos] ?? '');
  }
  let oi = 0;
  for (const op of ops) {
    if (op.k === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi++;
    } else if (op.k === 'old') {
      oi++;
    } else {
      let t = op.t;
      if (tier === 2 && t.trim() !== '' && t.startsWith(pLead)) t = fLead + t.slice(pLead.length);
      out.push(t);
    }
  }
  return out;
}

/** One unified hunk: its old start line, its lines, and whether a `\` line ends it. */
interface Hunk {
  a: number;
  ops: Op[];
  noEol: boolean;
  plusNoEol: boolean;
}

/** A unified section's hunks, applied in order to a file's text (SPEC.md section 6). */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    const o = opsOld(h.ops);
    if (o.length === 0) {
      const rep = h.ops.filter((op) => op.k === 'new').map((op) => op.t);
      const at = Math.min(h.a + d, f.lines.length);
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...rep);
      if (atEnd) f.final = !h.noEol;
      d += rep.length;
      continue;
    }
    const found = firstTierWith(f.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.positions[0]!;
    for (const p of found.positions) {
      const db = Math.abs(p - target);
      const bb = Math.abs(best - target);
      if (db < bb || (db === bb && p < best)) best = p;
    }
    const atEnd = best + o.length === f.lines.length;
    const rep = buildReplacement(h.ops, f.lines, best, found.tier);
    f.lines.splice(best, o.length, ...rep);
    if (atEnd) f.final = !h.noEol;
    d += rep.length - o.length;
  }
  return joinFile(f);
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits that succeeded, as (old path, new path) pairs, for the `R` output lines. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One unified section: where its paths come from, what kind it is, and its hunks. */
interface Section {
  pairOld: string | null;
  pairNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;

/** A `--- ` or `+++ ` path: the text after the four characters, up to a tab, trimmed, prefix removed. */
function headerPath(line: string): string {
  const body = line.slice(4);
  const tab = body.indexOf('\t');
  const p = (tab >= 0 ? body.slice(0, tab) : body).trim();
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.pairOld ?? sec.renFrom ?? sec.diffOld;
    const newP = sec.pairNew ?? sec.renTo ?? sec.diffNew;
    if (oldP === null || newP === null) throw new Fail('missing', oldP ?? newP ?? '');
    if (sec.create || oldP === '/dev/null') {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const op of h.ops) if (op.k === 'new') plus.push(op.t);
      let noEol = false;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const h = sec.hunks[hi]!;
        if (h.ops.some((op) => op.k === 'new')) { noEol = h.plusNoEol; break; }
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (sec.del || newP === '/dev/null') {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const text = tree.get(oldP);
      if (text === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(text, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push([oldP, newP]);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const text = tree.get(oldP);
    if (text === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyHunks(text, sec.hunks, strict, oldP));
  };
}

/** A unified patch (SPEC.md section 6) as one edit per section. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  const blankSection = (): Section => ({ pairOld: null, pairNew: null, renFrom: null, renTo: null, diffOld: null, diffNew: null, create: false, del: false, hunks: [] });
  let i = 0;
  const n = lines.length;
  let cur: Section | null = null;
  let headed = false;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = blankSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      sections.push(s);
      cur = s;
      headed = true;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && headed && cur.pairOld === null) {
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      const s = blankSection();
      s.pairOld = headerPath(line);
      s.pairNew = headerPath(lines[i + 1]!);
      sections.push(s);
      cur = s;
      headed = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i++;
      const body: string[] = [];
      while (i < n) {
        const l = lines[i]!;
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') { body.push(l); i++; continue; }
        break;
      }
      while (body.length > 0) {
        const last = body[body.length - 1]!;
        if (last === '' || last === ' ') body.pop();
        else break;
      }
      const ops: Op[] = [];
      let lastCN = -1;
      let lastPlus = -1;
      for (let k = 0; k < body.length; k++) {
        const b = body[k]!;
        if (b === '' || b[0] === ' ' || b[0] === '+') lastCN = k;
        if (b[0] === '+') lastPlus = k;
      }
      const noEol = lastCN >= 0 && body[lastCN + 1] !== undefined && body[lastCN + 1]![0] === '\\';
      const plusNoEol = lastPlus >= 0 && body[lastPlus + 1] !== undefined && body[lastPlus + 1]![0] === '\\';
      for (const b of body) {
        if (b === '' || b[0] === ' ') ops.push({ k: 'ctx', t: b === '' ? '' : b.slice(1) });
        else if (b[0] === '-') ops.push({ k: 'old', t: b.slice(1) });
        else if (b[0] === '+') ops.push({ k: 'new', t: b.slice(1) });
      }
      cur.hunks.push({ a, ops, noEol, plusNoEol });
      headed = false;
      continue;
    }
    if (cur !== null && headed) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) { if (cur.renFrom === null) cur.renFrom = line.slice(12).trim(); i++; continue; }
      if (line.startsWith('rename to ')) { if (cur.renTo === null) cur.renTo = line.slice(10).trim(); i++; continue; }
      if (line.startsWith('new file mode')) { cur.create = true; i++; continue; }
      if (line.startsWith('deleted file mode')) { cur.del = true; i++; continue; }
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const f = splitFile(text);
    const found = firstTierWith(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const ops: Op[] = [...oldLines.map((t): Op => ({ k: 'old', t })), ...newLines.map((t): Op => ({ k: 'new', t }))];
    const rep = buildReplacement(ops, f.lines, pos, found.tier);
    f.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, joinFile(f));
  };
}

/** SEARCH/REPLACE blocks (SPEC.md section 7) as one edit per block. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let blockStart = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j >= blockStart; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let end = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    }
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { end = j; break; }
      }
    }
    if (eq < 0 || end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, end);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    blockStart = end + 1;
    i = end + 1;
  }
  return edits;
}

/** One V4A chunk: its anchor, its lines, and whether `*** End of File` closes it. */
interface VChunk {
  anchor: string | null;
  ops: Op[];
  eof: boolean;
}

const isVSection = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

/** The first line at or after cursor equal to the anchor, at the first tier with one. */
function findAnchor(lines: string[], anchor: string, strict: boolean, cursor: number): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let j = cursor; j < lines.length; j++) {
      if (lineEq(lines[j]!, anchor, t)) return j;
    }
  }
  return null;
}

/** The first occurrence of old at or after cursor, at the first tier with one (an end-of-file chunk only takes one ending at the last line). */
function findChunkOccurrence(lines: string[], old: string[], strict: boolean, cursor: number, eof: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = occurrencesAt(lines, old, t, cursor).filter((p) => !eof || p + old.length === lines.length);
    if (positions.length > 0) return { tier: t, pos: positions[0]! };
  }
  return null;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const at = findAnchor(f.lines, ch.anchor, strict, cursor);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const o = opsOld(ch.ops);
      if (o.length === 0) {
        const rep = ch.ops.filter((op) => op.k === 'new').map((op) => op.t);
        const at = ch.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...rep);
        cursor = at + rep.length;
        continue;
      }
      const found = findChunkOccurrence(f.lines, o, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const rep = buildReplacement(ch.ops, f.lines, found.pos, found.tier);
      f.lines.splice(found.pos, o.length, ...rep);
      cursor = found.pos + rep.length;
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/** V4A patches (SPEC.md section 8) as one edit per section. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (lines[k]!.trim() !== '') { last = k; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (line.trim() === '') { i++; continue; }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice(14).trim();
      const secLines: string[] = [];
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (isVSection(l)) break;
        if (l.trim() === '') { secLines.push(''); i++; continue; }
        if (!l.startsWith('+')) throw new Exit2(`error: parse ${i + 1}`);
        secLines.push(l.slice(1));
        i++;
      }
      while (secLines.length > 0 && secLines[secLines.length - 1] === '') secLines.pop();
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, secLines.length === 0 ? '' : secLines.join('\n') + '\n');
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice(17).trim();
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (isVSection(l)) break;
        if (l.trim() === '') { i++; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice(17).trim();
      const hdr = i;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) { moveTo = lines[i]!.slice(13).trim(); i++; }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let firstChunk = true;
      while (i < last) {
        const l = lines[i]!;
        if (isVSection(l)) break;
        if (l.trimEnd() === '*** End of File' && l[0] === '*') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          firstChunk = false;
          i++;
          continue;
        }
        if (l.startsWith('@@')) {
          if (cur !== null) { chunks.push(cur); cur = null; }
          cur = { anchor: l.slice(2).trim(), ops: [], eof: false };
          firstChunk = false;
          i++;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, ops: [], eof: false };
            firstChunk = false;
          }
          cur.ops.push(l === '' ? { k: 'ctx', t: '' } : l[0] === ' ' ? { k: 'ctx', t: l.slice(1) } : l[0] === '-' ? { k: 'old', t: l.slice(1) } : { k: 'new', t: l.slice(1) });
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (cur !== null) { chunks.push(cur); cur = null; }
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.ops.length > 0) {
          const lastOp = lastChunk.ops[lastChunk.ops.length - 1]!;
          if (lastOp.k === 'ctx' && lastOp.t === '') lastChunk.ops.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${hdr + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const rows: { key: string; line: string }[] = [];
  const paired = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (!changed.includes(oldP) || !changed.includes(newP)) continue;
    if (tree.original(oldP) === null || tree.now.get(oldP) !== null) continue;
    if (tree.original(newP) !== null || tree.now.get(newP) === null) continue;
    rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    paired.add(oldP);
    paired.add(newP);
  }
  for (const p of changed) {
    if (paired.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
