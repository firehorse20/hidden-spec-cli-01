// main.ts is mend, the CLI SPEC.md specifies. Node 22 and its standard library alone;
// run it as `node main.ts [options] [PATCH]`. It reads a patch in one of four formats
// (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names
// at the first of three matching tiers, and writes every change or none.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this
// file hands over to runner.ts (the last lines below): keep that hand-over and runner.ts
// as they are.

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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in order, as [old, new] pairs (for the `R` output lines). */
  readonly moves: Array<[string, string]> = [];
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

/** A file split into lines under its own line break, with whether it ends with one. */
interface FileState {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

/** Line equality at one matching tier (SPEC section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position where O occurs in lines at one tier (overlaps allowed). */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const pos: number[] = [];
  if (o.length === 0) return pos;
  for (let i = 0; i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (!lineEq(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O occurs, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const p = occurrences(lines, o, t);
    if (p.length > 0) return { tier: t, positions: p };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NEntry {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Split a chunk body into its old lines O and its new lines N (with context marks). */
function buildON(body: Array<{ kind: string; text: string }>): { o: string[]; n: NEntry[] } {
  const o: string[] = [];
  const n: NEntry[] = [];
  for (const e of body) {
    if (e.kind === 'ctx') {
      o.push(e.text);
      n.push({ text: e.text, ctx: true, oIdx: o.length - 1 });
    } else if (e.kind === 'del') {
      o.push(e.text);
    } else if (e.kind === 'add') {
      n.push({ text: e.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

/** Tier 2 re-indent of one new line: P (O's first line's lead) replaced by F (file's lead). */
function reindent(text: string, p: string, f: string): string {
  if (text === '' || text.trim() === '') return text;
  if (text.startsWith(p)) return f + text.slice(p.length);
  return text;
}

/** Replace the lines at pos (an occurrence of O) by N, resolving context lines from the file. */
function applyReplace(lines: string[], o: string[], n: NEntry[], pos: number, tier: number): string[] {
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const f = pos < lines.length ? leadWs(lines[pos]!) : '';
  const out: string[] = [];
  for (const ne of n) {
    if (ne.ctx) out.push(lines[pos + ne.oIdx]!);
    else if (tier === 2) out.push(reindent(ne.text, p, f));
    else out.push(ne.text);
  }
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + o.length)];
}

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

/* ---- Unified diffs (SPEC section 6) ---- */

type BodyKind = 'ctx' | 'del' | 'add' | 'slash';
interface BodyEntry {
  kind: BodyKind;
  text: string;
}

interface Hunk {
  a: number;
  body: BodyEntry[];
  o: string[];
  n: NEntry[];
  noEol: boolean;
}

interface UniSection {
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  hasPair: boolean;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** One body line of a hunk, or null when the line is not a body line. */
function uniBodyEntry(l: string): BodyEntry | null {
  if (l.startsWith(' ')) return { kind: 'ctx', text: l.slice(1) };
  if (l.startsWith('-')) return { kind: 'del', text: l.slice(1) };
  if (l.startsWith('+')) return { kind: 'add', text: l.slice(1) };
  if (l.startsWith('\\')) return { kind: 'slash', text: l };
  if (l === '') return { kind: 'ctx', text: '' };
  return null;
}

/** The path after `--- ` / `+++ `: text after four chars, up to the first tab, trimmed, a/ or b/ removed. */
function uniPath(l: string): string {
  const t = l.slice(4).split('\t')[0]!.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) return t.slice(2);
  return t;
}

/** Finish a hunk: drop trailing empty context lines, split O/N, work out the no-newline flag. */
function finishHunk(h: Hunk): void {
  while (h.body.length > 0) {
    const last = h.body[h.body.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') h.body.pop();
    else break;
  }
  const split = buildON(h.body);
  h.o = split.o;
  h.n = split.n;
  let last = -1;
  for (let k = 0; k < h.body.length; k += 1) {
    if (h.body[k]!.kind === 'ctx' || h.body[k]!.kind === 'add') last = k;
  }
  h.noEol = last >= 0 && h.body[last + 1] !== undefined && h.body[last + 1]!.kind === 'slash';
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let phase: 'none' | 'header' | 'body' | 'between' = 'none';
  let curHunk: Hunk | null = null;
  const freshSection = (): UniSection => ({
    pairOld: null,
    pairNew: null,
    renameOld: null,
    renameNew: null,
    diffOld: null,
    diffNew: null,
    hasPair: false,
    create: false,
    del: false,
    hunks: [],
  });
  const closeBody = (): void => {
    if (curHunk !== null && cur !== null) {
      finishHunk(curHunk);
      cur.hunks.push(curHunk);
      curHunk = null;
    }
    phase = 'between';
  };
  const startSection = (diffOld: string | null, diffNew: string | null): void => {
    if (curHunk !== null) closeBody();
    if (cur !== null) sections.push(cur);
    cur = freshSection();
    cur.diffOld = diffOld;
    cur.diffNew = diffNew;
    phase = 'header';
  };
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ ]+) b\/([^ ]+)[ \t]*$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      continue;
    }
    if (curHunk !== null) {
      // The body ends at a `--- ` line followed by a `+++ ` line; any other
      // line starting with `-` is a body line, even one starting with `--- `.
      if (!(l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        const e = uniBodyEntry(l);
        if (e !== null) {
          curHunk.body.push(e);
          continue;
        }
      }
      closeBody();
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      curHunk = { a: parseInt(hm[1]!, 10), body: [], o: [], n: [], noEol: false };
      phase = 'body';
      continue;
    }
    if (l.startsWith('--- ')) {
      const nxt = lines[i + 1];
      if (nxt !== undefined && nxt.startsWith('+++ ')) {
        if (cur === null || phase !== 'header' || cur.hasPair) {
          startSection(null, null);
        }
        cur!.pairOld = uniPath(l);
        cur!.pairNew = uniPath(nxt);
        cur!.hasPair = true;
        i += 1;
        continue;
      }
      if (cur !== null && phase === 'header') throw new Exit2(`error: parse ${i + 2}`);
      continue;
    }
    if (cur !== null && phase === 'header') {
      if (l.startsWith('+++ ')) {
        if (cur.pairNew === null) cur.pairNew = uniPath(l);
      } else if (l.startsWith('rename from ')) {
        cur.renameOld = l.slice(12).trim();
      } else if (l.startsWith('rename to ')) {
        cur.renameNew = l.slice(10).trim();
      } else if (l.startsWith('new file mode')) {
        cur.create = true;
      } else if (l.startsWith('deleted file mode')) {
        cur.del = true;
      }
      continue;
    }
  }
  if (curHunk !== null) closeBody();
  if (cur !== null) sections.push(cur);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => uniEdit(sec, strict));
}

/** Apply one hunk to a file state; d is the length drift of this section's earlier hunks. */
function applyUniHunk(f: FileState, h: Hunk, d: number, strict: boolean, path: string): FileState {
  const lines = f.lines;
  let final = f.final;
  if (h.o.length === 0) {
    const ins = Math.max(0, Math.min(h.a + d, lines.length));
    const out = h.n.map((e) => e.text);
    if (ins === lines.length) final = !h.noEol;
    return { lines: [...lines.slice(0, ins), ...out, ...lines.slice(ins)], br: f.br, final };
  }
  const found = findTier(lines, h.o, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.positions[0]!;
  for (const p of found.positions) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const nl = applyReplace(lines, h.o, h.n, best, found.tier);
  if (best + h.o.length === lines.length) final = !h.noEol;
  return { lines: nl, br: f.br, final };
}

function uniEdit(sec: UniSection, strict: boolean): Edit {
  const oldP = sec.pairOld ?? sec.renameOld ?? sec.diffOld ?? '';
  const newP = sec.pairNew ?? sec.renameNew ?? sec.diffNew ?? '';
  return (tree) => {
    const isCreate = sec.create || oldP === '/dev/null';
    const isDelete = !isCreate && (sec.del || newP === '/dev/null');
    if (isCreate) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let noEol = false;
      for (const h of sec.hunks) {
        let lastAdd = -1;
        for (let k = 0; k < h.body.length; k += 1) {
          const e = h.body[k]!;
          if (e.kind === 'add') {
            plus.push(e.text);
            lastAdd = k;
          }
        }
        if (lastAdd >= 0) noEol = h.body[lastAdd + 1] !== undefined && h.body[lastAdd + 1]!.kind === 'slash';
      }
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    if (oldP !== newP && !safe(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (oldP !== newP && tree.get(newP) !== null) throw new Fail('exists', newP);
    let f = parseFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      f = applyUniHunk(f, h, d, strict, oldP);
      d += h.n.length - h.o.length;
    }
    const out = renderFile(f);
    if (oldP !== newP) {
      tree.now.set(oldP, null);
      tree.now.set(newP, out);
      tree.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, out);
    }
  };
}

/* ---- SEARCH/REPLACE blocks (SPEC section 7) ---- */

interface SrBlock {
  path: string;
  old: string[];
  nw: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${i + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${i + 1}`);
    let path: string | null = null;
    for (let k = i - 1; k > prevEnd; k -= 1) {
      const t = lines[k]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    prevPath = path;
    blocks.push({ path, old: lines.slice(i + 1, eq), nw: lines.slice(eq + 1, rep) });
    prevEnd = rep;
    i = rep;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => srEdit(b, strict));
}

function srEdit(b: SrBlock, strict: boolean): Edit {
  return (tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.nw.length === 0 ? '' : b.nw.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const f = parseFile(before);
    const found = findTier(f.lines, b.old, strict);
    if (found === null) throw new Fail('no-match', p);
    if (found.positions.length > 1) throw new Fail('ambiguous', p);
    const nEntries: NEntry[] = b.nw.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
    const out = applyReplace(f.lines, b.old, nEntries, found.positions[0]!, found.tier);
    tree.now.set(p, renderFile({ lines: out, br: f.br, final: f.final }));
  };
}

/* ---- V4A patches (SPEC section 8) ---- */

interface V4aChunk {
  anchor: string | null;
  body: Array<{ kind: string; text: string }>;
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'del' | 'upd';
  path: string;
  moveTo: string | null;
  chunks: V4aChunk[];
  addLines: string[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i += 1;
    if (i >= last) break;
    const l = lines[i]!;
    let kind: 'add' | 'del' | 'upd';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice(14).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'del';
      path = l.slice(17).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'upd';
      path = l.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sectionLine = i;
    i += 1;
    const raw: Array<{ t: string; no: number }> = [];
    while (i < last) {
      const r = lines[i]!;
      if (r.startsWith('*** Add File: ') || r.startsWith('*** Delete File: ') || r.startsWith('*** Update File: ')) break;
      raw.push({ t: r, no: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.t)) raw.pop();
    edits.push(v4aSectionEdit(v4aParseSection(kind, path, raw, sectionLine + 1), strict));
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/** Parse one V4A section's raw lines (blank lines at its end already stripped). */
function v4aParseSection(kind: 'add' | 'del' | 'upd', path: string, raw: Array<{ t: string; no: number }>, sectionNo: number): V4aSection {
  if (kind === 'add') {
    const addLines: string[] = [];
    for (const r of raw) {
      if (r.t.startsWith('+')) addLines.push(r.t.slice(1));
      else if (blank(r.t)) addLines.push('');
      else throw new Exit2(`error: parse ${r.no}`);
    }
    return { kind, path, moveTo: null, chunks: [], addLines };
  }
  if (kind === 'del') {
    if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.no}`);
    return { kind, path, moveTo: null, chunks: [], addLines: [] };
  }
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.t.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.t.slice(13).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  let started = false;
  for (; idx < raw.length; idx += 1) {
    const { t, no } = raw[idx]!;
    if (t.trim() === '*** End of File') {
      if (cur === null) {
        chunks.push({ anchor: null, body: [], eof: true });
        started = true;
      } else {
        cur.eof = true;
        cur = null;
      }
      continue;
    }
    if (t.startsWith('@@')) {
      cur = { anchor: t.slice(2).trim() === '' ? null : t.slice(2).trim(), body: [], eof: false };
      chunks.push(cur);
      started = true;
      continue;
    }
    if (t.startsWith(' ') || t.startsWith('-') || t.startsWith('+') || blank(t)) {
      if (cur === null) {
        if (!started) {
          cur = { anchor: null, body: [], eof: false };
          chunks.push(cur);
          started = true;
        } else {
          throw new Exit2(`error: parse ${no}`);
        }
      }
      if (t.startsWith(' ')) cur.body.push({ kind: 'ctx', text: t.slice(1) });
      else if (t.startsWith('-')) cur.body.push({ kind: 'del', text: t.slice(1) });
      else if (t.startsWith('+')) cur.body.push({ kind: 'add', text: t.slice(1) });
      else cur.body.push({ kind: 'ctx', text: '' });
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  if (!started && moveTo === null) throw new Exit2(`error: parse ${sectionNo}`);
  return { kind, path, moveTo, chunks, addLines: [] };
}

/** First line at or after cursor equal to the anchor at the first tier with one, or null. */
function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = cursor; i < lines.length; i += 1) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return null;
}

function v4aSectionEdit(sec: V4aSection, strict: boolean): Edit {
  if (sec.kind === 'add') {
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
    };
  }
  if (sec.kind === 'del') {
    return (tree) => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
    };
  }
  return (tree) => {
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = parseFile(before);
    let lines = f.lines;
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(lines, ch.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const split = buildON(ch.body);
      if (split.o.length === 0) {
        const ins = ch.eof ? lines.length : cursor;
        const out = split.n.map((e) => e.text);
        lines = [...lines.slice(0, ins), ...out, ...lines.slice(ins)];
        cursor = ins + out.length;
      } else {
        const tiers = strict ? [0] : [0, 1, 2];
        let found: { pos: number; tier: number } | null = null;
        for (const t of tiers) {
          const cands = occurrences(lines, split.o, t).filter((pos) => pos >= cursor && (!ch.eof || pos + split.o.length === lines.length));
          if (cands.length > 0) {
            found = { pos: cands[0]!, tier: t };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', p);
        lines = applyReplace(lines, split.o, split.n, found.pos, found.tier);
        cursor = found.pos + split.n.length;
      }
    }
    const out = renderFile({ lines, br: f.br, final: f.final });
    if (sec.moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(sec.moveTo, out);
      tree.moves.push([p, sec.moveTo]);
    } else {
      tree.now.set(p, out);
    }
  };
}

/* ---- Running (SPEC sections 1, 2, 10) ---- */

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
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()]
    .filter((p) => tree.original(p) !== tree.now.get(p))
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const rows: Array<{ key: string; text: string }> = [];
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null) {
      rows.push({ key: n, text: `R ${o} -> ${n}` });
      rOld.add(o);
      rNew.add(n);
    }
  }
  for (const p of changed) {
    if (rOld.has(p) || rNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
