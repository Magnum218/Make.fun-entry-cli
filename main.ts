// mend: one patch tool for every AI edit format.
//
// mend applies an edit an AI model wrote to a tree of text files. The edit arrives in one of four
// formats - a unified diff (its line numbers may be wrong), SEARCH/REPLACE blocks, a V4A patch, or
// text-editor tool calls as JSON - and is read exactly as SPEC.md says: the lines an edit names are
// found at the first of three matching tiers (exact, then trailing-whitespace tolerant, then fully
// whitespace tolerant), and either every change is written or none is. Node 22, standard library
// alone; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): that hand-over and runner.ts stay as the kit has them.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 failure: exactly one line of output, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: a code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

interface Move {
  old: string;
  new: string;
}

type Edit = (tree: Tree, moves: Move[]) => void;

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed from each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is relative, holds no backslash, and no segment is empty, . or ... */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

interface FileParts {
  lines: string[];
  br: string;
  final: boolean;
}

/** Split a file's text into lines at its own line break, remembering whether it ends with one. */
function splitFile(text: string): FileParts {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

/** Join lines back with the file's break; a file of no lines is written empty. */
function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

/**
 * The tree as the edits leave it. `now` holds every path an edit has set (null: deleted); any other
 * path is read from disk on first use, which is also how its pre-patch bytes are remembered.
 */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

// ---------------------------------------------------------------- matching (SPEC.md section 5)

type LineKind = 'ctx' | 'old' | 'new';
interface BodyLine {
  kind: LineKind;
  text: string;
  /** A `\` line follows this body line (unified diffs: no line break after it). */
  noBreak: boolean;
}

/** A line as a tier sees it: tier 1 drops trailing spaces and tabs, tier 2 drops leading ones too. */
function tierLine(line: string, tier: number): string {
  if (tier === 0) return line;
  const t = line.replace(/[ \t]+$/, '');
  return tier === 1 ? t : t.replace(/^[ \t]+/, '');
}

function leadingWs(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m === null ? '' : m[0];
}

/** Every start position >= from at which O occurs in lines at the tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], from: number, tier: number, eofOnly: boolean): number[] {
  const out: number[] = [];
  const last = lines.length - o.length;
  for (let i = Math.max(from, 0); i <= last; i += 1) {
    if (eofOnly && i !== last) continue;
    let ok = true;
    for (let j = 0; j < o.length; j += 1) {
      if (tierLine(lines[i + j]!, tier) !== tierLine(o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Match {
  tier: number;
  positions: number[];
}

/** The first tier at which O occurs at or after `from`, and its positions there; null when none. */
function matchTier(lines: string[], o: string[], from: number, strict: boolean, eofOnly = false): Match | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrences(lines, o, from, tier, eofOnly);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** A tier-2 line of N that is not a context line is re-indented from O's first line to the file's. */
function reindent(text: string, f: string, p: string): string {
  if (text === '' || /^[ \t]+$/.test(text)) return text;
  if (text.startsWith(p)) return f + text.slice(p.length);
  return text;
}

/**
 * The lines N writes over a match of O at `pos`: a context line is written as the file's own matched
 * line, never the patch's; at tier 2 every other line of N is re-indented.
 */
function writtenLines(lines: string[], pos: number, o: BodyLine[], n: BodyLine[], tier: number): string[] {
  const ctxAt: number[] = [];
  o.forEach((b, j) => {
    if (b.kind === 'ctx') ctxAt.push(j);
  });
  let ci = 0;
  const f = leadingWs(lines[pos] ?? '');
  const p = o.length > 0 ? leadingWs(o[0]!.text) : '';
  const out: string[] = [];
  for (const b of n) {
    if (b.kind === 'ctx') {
      out.push(lines[pos + ctxAt[ci]!]!);
      ci += 1;
    } else if (tier === 2) {
      out.push(reindent(b.text, f, p));
    } else {
      out.push(b.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------- unified diffs (section 6)

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  gitOld?: string;
  gitNew?: string;
  pairOld?: string;
  pairNew?: string;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** A path as a git header line gives it: up to the first tab, with surrounding spaces removed. */
function gitHeaderPath(t: string): string {
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return t.trim();
}

/** The path a --- or +++ line names: the text after the four characters, read as a header path. */
function headerPath(line: string): string {
  return gitHeaderPath(line.slice(4));
}

/** A leading a/ or b/ is removed from a header path; /dev/null is left alone. */
function stripPrefix(p: string): string {
  if (p === '/dev/null') return p;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The two paths of a `diff --git a/<X> b/<Y>` line, or a parse error at its line. */
function gitPaths(line: string, lineNo: number): [string, string] {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) throw new Exit2(`error: parse ${lineNo}`);
  const idx = rest.indexOf(' b/', 2);
  if (idx < 0 || idx === 2 || idx + 3 >= rest.length) throw new Exit2(`error: parse ${lineNo}`);
  return [rest.slice(2, idx), rest.slice(idx + 3)];
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const start = (): Section => {
    const s: Section = { newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (line.startsWith('diff --git ')) {
      const [x, y] = gitPaths(line, lineNo);
      const s = start();
      s.gitOld = x;
      s.gitNew = y;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (cur !== null && inHeader && cur.pairOld === undefined) {
          cur.pairOld = stripPrefix(headerPath(line));
          cur.pairNew = stripPrefix(headerPath(next));
        } else {
          const s = start();
          s.pairOld = stripPrefix(headerPath(line));
          s.pairNew = stripPrefix(headerPath(next));
        }
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${lineNo + 1}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${lineNo}`);
      const a = Number(m[1]);
      const raw: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        const c = l[0];
        if (l === '' || c === ' ' || c === '-' || c === '+' || c === '\\') {
          raw.push(l);
          j += 1;
        } else break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const body: BodyLine[] = [];
      for (const l of raw) {
        if (l === '') body.push({ kind: 'ctx', text: '', noBreak: false });
        else if (l[0] === ' ') body.push({ kind: 'ctx', text: l.slice(1), noBreak: false });
        else if (l[0] === '-') body.push({ kind: 'old', text: l.slice(1), noBreak: false });
        else if (l[0] === '+') body.push({ kind: 'new', text: l.slice(1), noBreak: false });
        else if (body.length > 0) body[body.length - 1]!.noBreak = true;
      }
      cur.hunks.push({ a, body });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = gitHeaderPath(line.slice('rename from '.length));
      else if (line.startsWith('rename to ')) cur.renameTo = gitHeaderPath(line.slice('rename to '.length));
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i += 1;
  }
  return sections;
}

/** Whether a `\` line follows the hunk's last context or + line. */
function lastNoBreak(body: BodyLine[]): boolean {
  for (let k = body.length - 1; k >= 0; k -= 1) {
    const b = body[k]!;
    if (b.kind === 'ctx' || b.kind === 'new') return b.noBreak;
  }
  return false;
}

/** Apply one section's hunks, in order, to a file's text; a hunk that finds nothing fails the edit. */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let lines = f.lines;
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    const o = h.body.filter((b) => b.kind !== 'new');
    const n = h.body.filter((b) => b.kind !== 'old');
    if (o.length === 0) {
      let pos = h.a + d;
      if (pos > lines.length) pos = lines.length;
      if (pos < 0) pos = 0;
      const atEnd = pos === lines.length;
      lines = [...lines.slice(0, pos), ...n.map((b) => b.text), ...lines.slice(pos)];
      if (atEnd) final = !lastNoBreak(h.body);
      d += n.length;
      continue;
    }
    const m = matchTier(lines, o.map((b) => b.text), 0, strict);
    if (m === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = m.positions[0]!;
    for (const p of m.positions) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const written = writtenLines(lines, best, o, n, m.tier);
    const runsToEnd = best + o.length === lines.length;
    lines = [...lines.slice(0, best), ...written, ...lines.slice(best + o.length)];
    if (runsToEnd) final = !lastNoBreak(h.body);
    d += n.length - o.length;
  }
  return joinFile(lines, f.br, final);
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec): Edit => {
    const oldPath = sec.pairOld ?? sec.renameFrom ?? sec.gitOld;
    const newPath = sec.pairNew ?? sec.renameTo ?? sec.gitNew;
    const isCreate = sec.newFile || oldPath === '/dev/null';
    const isDelete = sec.delFile || newPath === '/dev/null';
    return (tree, moves) => {
      if (isCreate) {
        const p = newPath!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        const plus: BodyLine[] = [];
        for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'new') plus.push(b);
        let text = '';
        if (plus.length > 0) {
          text = plus.map((b) => b.text).join('\n');
          if (!plus[plus.length - 1]!.noBreak) text += '\n';
        }
        tree.now.set(p, text);
        return;
      }
      if (isDelete) {
        const p = oldPath!;
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      const o = oldPath!;
      const n = newPath!;
      if (o === n) {
        if (!safe(o)) throw new Fail('unsafe', o);
        const before = tree.get(o);
        if (before === null) throw new Fail('missing', o);
        tree.now.set(o, applyHunks(before, sec.hunks, strict, o));
        return;
      }
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(n)) throw new Fail('unsafe', n);
      const before = tree.get(o);
      if (before === null) throw new Fail('missing', o);
      if (tree.get(n) !== null) throw new Fail('exists', n);
      tree.now.set(n, applyHunks(before, sec.hunks, strict, o));
      tree.now.set(o, null);
      moves.push({ old: o, new: n });
    };
  });
}

// ---------------------------------------------------------------- SEARCH/REPLACE (section 7)

interface Block {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let sep = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        end = j;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let j = i - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    blocks.push({ path, oldLines: lines.slice(i + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevEnd = end;
    prevPath = path;
    i = end + 1;
  }
  return blocks;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  return parseSearchReplace(lines).map((block): Edit => {
    return (tree) => {
      const p = block.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (block.oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, block.newLines.length === 0 ? '' : `${block.newLines.join('\n')}\n`);
        return;
      }
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      const m = matchTier(f.lines, block.oldLines, 0, strict);
      if (m === null) throw new Fail('no-match', p);
      if (m.positions.length > 1) throw new Fail('ambiguous', p);
      const pos = m.positions[0]!;
      const o: BodyLine[] = block.oldLines.map((t) => ({ kind: 'old', text: t, noBreak: false }));
      const n: BodyLine[] = block.newLines.map((t) => ({ kind: 'new', text: t, noBreak: false }));
      const written = writtenLines(f.lines, pos, o, n, m.tier);
      const out = [...f.lines.slice(0, pos), ...written, ...f.lines.slice(pos + block.oldLines.length)];
      tree.now.set(p, joinFile(out, f.br, f.final));
    };
  });
}

// ---------------------------------------------------------------- V4A patches (section 8)

interface Chunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  headerLine: number;
  addLines: string[];
  moveTo?: string;
  chunks: Chunk[];
}

const V_PREFIX = { add: '*** Add File: ', delete: '*** Delete File: ', update: '*** Update File: ' } as const;

function vKind(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith(V_PREFIX.add)) return 'add';
  if (line.startsWith(V_PREFIX.delete)) return 'delete';
  if (line.startsWith(V_PREFIX.update)) return 'update';
  return null;
}

function parseV4a(lines: string[]): VSection[] {
  const fb = lines.findIndex((l) => !blank(l));
  if (fb < 0) throw new Exit2('error: parse 1');
  if (lines[fb]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${fb + 1}`);
  let lb = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      lb = j;
      break;
    }
  }
  if (lines[lb]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = fb + 1;
  while (i < lb) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = vKind(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const sec: VSection = { kind, path: line.slice(V_PREFIX[kind].length).trim(), headerLine: i + 1, addLines: [], chunks: [] };
    let j = i + 1;
    const bodyIdx: number[] = [];
    while (j < lb && vKind(lines[j]!) === null) {
      bodyIdx.push(j);
      j += 1;
    }
    while (bodyIdx.length > 0 && blank(lines[bodyIdx[bodyIdx.length - 1]!]!)) bodyIdx.pop();
    if (kind === 'delete') {
      if (bodyIdx.length > 0) throw new Exit2(`error: parse ${bodyIdx[0]! + 1}`);
    } else if (kind === 'add') {
      for (const idx of bodyIdx) {
        const l = lines[idx]!;
        if (l === '') sec.addLines.push('');
        else if (l.startsWith('+')) sec.addLines.push(l.slice(1));
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
    } else {
      let start = 0;
      if (bodyIdx.length > 0 && lines[bodyIdx[0]!]!.startsWith('*** Move to: ')) {
        sec.moveTo = lines[bodyIdx[0]!]!.slice('*** Move to: '.length).trim();
        start = 1;
      }
      let cur: Chunk | null = null;
      for (let k = start; k < bodyIdx.length; k += 1) {
        const idx = bodyIdx[k]!;
        const l = lines[idx]!;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          sec.chunks.push(cur);
        } else if (l.trimEnd() === '*** End of File' && !l.startsWith(' ')) {
          if (cur === null) {
            cur = { anchor: null, body: [], eof: true };
            sec.chunks.push(cur);
          } else cur.eof = true;
          cur = null;
        } else if (l.startsWith('*** Move to: ')) {
          throw new Exit2(`error: parse ${idx + 1}`);
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${idx + 1}`);
            cur = { anchor: null, body: [], eof: false };
            sec.chunks.push(cur);
          }
          if (l === '') cur.body.push({ kind: 'ctx', text: '', noBreak: false });
          else if (l[0] === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1), noBreak: false });
          else if (l[0] === '-') cur.body.push({ kind: 'old', text: l.slice(1), noBreak: false });
          else cur.body.push({ kind: 'new', text: l.slice(1), noBreak: false });
        } else {
          throw new Exit2(`error: parse ${idx + 1}`);
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === undefined) throw new Exit2(`error: parse ${sec.headerLine}`);
    }
    sections.push(sec);
    i = j;
  }
  return sections;
}

/** The first line at or after `from` equal to the anchor, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    for (let i = from; i < lines.length; i += 1) {
      if (tierLine(lines[i]!, tier) === tierLine(anchor, tier)) return i;
    }
  }
  return -1;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4a(lines).map((sec): Edit => {
    return (tree, moves) => {
      const p = sec.path;
      if (sec.kind === 'add') {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, sec.addLines.length === 0 ? '' : `${sec.addLines.join('\n')}\n`);
        return;
      }
      if (sec.kind === 'delete') {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
        return;
      }
      if (!safe(p)) throw new Fail('unsafe', p);
      if (sec.moveTo !== undefined && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (sec.moveTo !== undefined && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
      const f = splitFile(before);
      let lines = f.lines;
      let cursor = 0;
      for (const chunk of sec.chunks) {
        if (chunk.anchor !== null) {
          const at = findAnchor(lines, chunk.anchor, cursor, strict);
          if (at < 0) throw new Fail('no-match', p);
          cursor = at + 1;
        }
        const o = chunk.body.filter((b) => b.kind !== 'new');
        const n = chunk.body.filter((b) => b.kind !== 'old');
        if (o.length === 0) {
          const pos = chunk.eof ? lines.length : Math.min(cursor, lines.length);
          const written = n.map((b) => b.text);
          lines = [...lines.slice(0, pos), ...written, ...lines.slice(pos)];
          cursor = pos + written.length;
          continue;
        }
        const m = matchTier(lines, o.map((b) => b.text), cursor, strict, chunk.eof);
        if (m === null) throw new Fail('no-match', p);
        const pos = m.positions[0]!;
        const written = writtenLines(lines, pos, o, n, m.tier);
        lines = [...lines.slice(0, pos), ...written, ...lines.slice(pos + o.length)];
        cursor = pos + written.length;
      }
      const out = joinFile(lines, f.br, f.final);
      if (sec.moveTo !== undefined) {
        tree.now.set(sec.moveTo, out);
        tree.now.set(p, null);
        moves.push({ old: p, new: sec.moveTo });
      } else {
        tree.now.set(p, out);
      }
    };
  });
}

// ---------------------------------------------------------------- JSON edits (section 9)

/** One JSON edit object, or null when it is not one: a wrong command or a missing or mistyped key. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      let at = -1;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) {
        count += 1;
        at = k;
      }
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const out = [...f.lines.slice(0, line), ...add, ...f.lines.slice(line)];
      tree.now.set(p, joinFile(out, f.br, f.final));
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

// ---------------------------------------------------------------- detection (section 4)

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

// ---------------------------------------------------------------- the run (sections 1, 2, 10)

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice('--format='.length))) {
        format = a.slice('--format='.length);
      } else if (a === '--check' && !check) {
        check = true;
      } else if (a === '--strict' && !strict) {
        strict = true;
      } else {
        return { code: 2, out: ['error: usage'] };
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  if (file === null) {
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      text = '';
    }
  } else {
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return { code: 2, out: ['error: no-patch'] };
    }
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else if (kind === 'v4a') edits = v4aEdits(lines, strict);
    else edits = jsonEdits(text, lines);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  if (edits.length === 0) return { code: 2, out: ['error: parse 1'] };
  const tree = new Tree();
  const moves: Move[] = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snapshot = new Map(tree.now);
    const moveCount = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of snapshot) tree.now.set(k, v);
      moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const mv of moves) {
    const wasOld = tree.original(mv.old);
    const nowOld = tree.get(mv.old);
    const wasNew = tree.original(mv.new);
    const nowNew = tree.get(mv.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: mv.new, line: `R ${mv.old} -> ${mv.new}` });
      consumed.add(mv.old);
      consumed.add(mv.new);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
