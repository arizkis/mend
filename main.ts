// mend implements SPEC.md using only the Node 22 standard library.
// Run it as `node main.ts [options] [PATCH]`.
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

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; next: string }[] = [];
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

interface TextFile {
  lines: string[];
  br: string;
  final: boolean;
}

function readLines(text: string): TextFile {
  const lf = text.indexOf('\n');
  const br = lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
  const final = text !== '' && text.endsWith(br);
  const lines = text === '' ? [] : text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function writeLines(file: TextFile): string {
  return file.lines.length === 0 ? '' : file.lines.join(file.br) + (file.final ? file.br : '');
}

function normalize(line: string, tier: number): string {
  if (tier === 0) return line;
  const right = line.replace(/[ \t]+$/, '');
  return tier === 1 ? right : right.replace(/^[ \t]+/, '');
}

/** Filter positions before choosing a tier: cursor and EOF restrictions are part of a match. */
function occurrences(lines: string[], old: string[], strict: boolean, start = 0, eof = false): { positions: number[]; tier: number } {
  for (let tier = 0; tier <= (strict ? 0 : 2); tier += 1) {
    const wanted = old.map((l) => normalize(l, tier));
    const positions: number[] = [];
    for (let i = start; i + old.length <= lines.length; i += 1) {
      if (eof && i + old.length !== lines.length) continue;
      if (wanted.every((l, j) => l === normalize(lines[i + j]!, tier))) positions.push(i);
    }
    if (positions.length > 0) return { positions, tier };
  }
  return { positions: [], tier: 0 };
}

interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
  noBreak?: boolean;
}

function oldLines(body: BodyLine[]): string[] {
  return body.filter((l) => l.kind !== '+').map((l) => l.text);
}

/** Context is copied from the file, while only replacement lines receive tier-2 indentation. */
function replacement(body: BodyLine[], matched: string[], old: string[], tier: number): string[] {
  const fileIndent = (matched[0] ?? '').match(/^[ \t]*/)![0];
  const patchIndent = (old[0] ?? '').match(/^[ \t]*/)![0];
  const out: string[] = [];
  let cursor = 0;
  for (const line of body) {
    if (line.kind === ' ') out.push(matched[cursor++]!);
    else if (line.kind === '-') cursor += 1;
    else {
      let text = line.text;
      if (tier === 2 && !blank(text) && text.startsWith(patchIndent)) text = fileIndent + text.slice(patchIndent.length);
      out.push(text);
    }
  }
  return out;
}

function checkPaths(paths: string[]): void {
  for (const p of paths) if (!safe(p)) throw new Fail('unsafe', p);
}

function existing(tree: Tree, path: string): TextFile {
  const text = tree.get(path);
  if (text === null) throw new Fail('missing', path);
  return readLines(text);
}

function storeUpdate(tree: Tree, path: string, next: string, file: TextFile): void {
  tree.now.set(next, writeLines(file));
  if (next !== path) {
    tree.now.set(path, null);
    tree.moves.push({ old: path, next });
  }
}

function searchEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let previousEnd = -1;
  let previousPath: string | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let path: string | undefined;
    for (let j = i - 1; j > previousEnd; j -= 1) {
      const candidate = lines[j]!.trim();
      if (candidate !== '' && !candidate.startsWith('```')) {
        path = candidate;
        break;
      }
    }
    path ??= previousPath;
    if (path === undefined) throw new Exit2(`error: parse ${i + 1}`);
    let separator = i + 1;
    while (separator < lines.length && lines[separator]!.trimEnd() !== '=======') separator += 1;
    let end = separator + 1;
    while (end < lines.length && lines[end]!.trimEnd() !== '>>>>>>> REPLACE') end += 1;
    if (end >= lines.length) throw new Exit2(`error: parse ${i + 1}`);
    const old = lines.slice(i + 1, separator);
    const added = lines.slice(separator + 1, end);
    const p = path;
    edits.push((tree) => {
      checkPaths([p]);
      if (old.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, writeLines({ lines: added, br: '\n', final: true }));
        return;
      }
      const file = existing(tree, p);
      const match = occurrences(file.lines, old, strict);
      if (match.positions.length === 0) throw new Fail('no-match', p);
      if (match.positions.length !== 1) throw new Fail('ambiguous', p);
      const at = match.positions[0]!;
      const body: BodyLine[] = [...old.map((text): BodyLine => ({ kind: '-', text })), ...added.map((text): BodyLine => ({ kind: '+', text }))];
      file.lines.splice(at, old.length, ...replacement(body, file.lines.slice(at, at + old.length), old, match.tier));
      tree.now.set(p, writeLines(file));
    });
    previousPath = p;
    previousEnd = end;
    i = end;
  }
  return edits;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}
interface UnifiedSection {
  old: string;
  next: string;
  create: boolean;
  remove: boolean;
  pair: boolean;
  hunks: Hunk[];
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let section: UnifiedSection | undefined;
  const pairAt = (i: number): boolean => lines[i]?.startsWith('--- ') === true && lines[i + 1]?.startsWith('+++ ') === true;
  const path = (s: string): string => s.split('\t')[0]!.trim().replace(/^[ab]\//, '');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      section = { old: m[1]!, next: m[2]!, create: false, remove: false, pair: false, hunks: [] };
      sections.push(section);
    } else if (line.startsWith('--- ') && (pairAt(i) || (section !== undefined && section.hunks.length === 0))) {
      if (!pairAt(i)) throw new Exit2(`error: parse ${i + 2}`);
      if (!section || section.pair || section.hunks.length > 0) {
        section = { old: '', next: '', create: false, remove: false, pair: false, hunks: [] };
        sections.push(section);
      }
      section.old = path(line.slice(4));
      section.next = path(lines[++i]!.slice(4));
      section.pair = true;
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:.*)$/.exec(line);
      if (!section || !m) throw new Exit2(`error: parse ${i + 1}`);
      const raw: string[] = [];
      let end = i + 1;
      while (end < lines.length) {
        const s = lines[end]!;
        if (s.startsWith('diff --git') || pairAt(end) || (s !== '' && !/^[ +\-\\]/.test(s))) break;
        raw.push(s);
        end += 1;
      }
      while (raw.at(-1) === '') raw.pop();
      const body: BodyLine[] = [];
      for (const s of raw) {
        if (s.startsWith('\\')) {
          if (body.length > 0) body[body.length - 1]!.noBreak = true;
        } else body.push({ kind: s === '' ? ' ' : s[0] as BodyLine['kind'], text: s.slice(1) });
      }
      section.hunks.push({ a: Number(m[1]), body });
      i = end - 1;
    } else if (section && section.hunks.length === 0) {
      if (!section.pair && line.startsWith('rename from ')) section.old = line.slice(12).trim();
      else if (!section.pair && line.startsWith('rename to ')) section.next = line.slice(10).trim();
      else if (line.startsWith('new file mode')) section.create = true;
      else if (line.startsWith('deleted file mode')) section.remove = true;
    }
  }
  return sections.map((s): Edit => (tree) => {
    const create = s.create || s.old === '/dev/null';
    const remove = !create && (s.remove || s.next === '/dev/null');
    checkPaths([s.old, s.next].filter((p) => p !== '/dev/null'));
    if (create) {
      if (tree.get(s.next) !== null) throw new Fail('exists', s.next);
      const added = s.hunks.flatMap((h) => h.body.filter((l) => l.kind === '+'));
      tree.now.set(s.next, writeLines({ lines: added.map((l) => l.text), br: '\n', final: !added.at(-1)?.noBreak }));
      return;
    }
    const file = existing(tree, s.old);
    if (remove) {
      tree.now.set(s.old, null);
      return;
    }
    if (s.next !== s.old && tree.get(s.next) !== null) throw new Fail('exists', s.next);
    let drift = 0;
    for (const h of s.hunks) {
      const old = oldLines(h.body);
      let at: number;
      let tier = 0;
      if (old.length === 0) at = Math.max(0, Math.min(file.lines.length, h.a + drift));
      else {
        const match = occurrences(file.lines, old, strict);
        if (match.positions.length === 0) throw new Fail('no-match', s.old);
        const target = h.a - 1 + drift;
        at = match.positions.reduce((best, p) => Math.abs(p - target) < Math.abs(best - target) ? p : best);
        tier = match.tier;
      }
      const added = replacement(h.body, file.lines.slice(at, at + old.length), old, tier);
      if (at + old.length === file.lines.length) file.final = !h.body.filter((l) => l.kind !== '-').at(-1)?.noBreak;
      file.lines.splice(at, old.length, ...added);
      drift += added.length - old.length;
    }
    storeUpdate(tree, s.old, s.next, file);
  });
}

interface Chunk {
  anchor: string;
  eof: boolean;
  body: BodyLine[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const header = (s: string): RegExpExecArray | null => /^\*\*\* (Add|Delete|Update) File: (.*)$/.exec(s);
  for (let i = first + 1; i < last;) {
    if (blank(lines[i]!)) { i += 1; continue; }
    const m = header(lines[i]!);
    if (!m) throw new Exit2(`error: parse ${i + 1}`);
    const sectionLine = i + 1;
    const kind = m[1]!;
    const p = m[2]!.trim();
    let end = i + 1;
    while (end < last && !header(lines[end]!)) end += 1;
    let bodyEnd = end;
    while (bodyEnd > i + 1 && blank(lines[bodyEnd - 1]!)) bodyEnd -= 1;
    let at = i + 1;
    let next = p;
    let move = false;
    const chunks: Chunk[] = [];
    const added: string[] = [];
    if (kind === 'Add') {
      for (; at < bodyEnd; at += 1) {
        const s = lines[at]!;
        if (s !== '' && !s.startsWith('+')) throw new Exit2(`error: parse ${at + 1}`);
        added.push(s.slice(1));
      }
    } else if (kind === 'Delete') {
      if (at < bodyEnd) throw new Exit2(`error: parse ${at + 1}`);
    } else {
      if (at < bodyEnd && lines[at]!.startsWith('*** Move to: ')) {
        move = true;
        next = lines[at++]!.slice(13).trim();
      }
      let chunk: Chunk | undefined;
      for (; at < bodyEnd; at += 1) {
        const s = lines[at]!;
        if (s.startsWith('@@')) {
          chunk = { anchor: s.slice(2).trim(), eof: false, body: [] };
          chunks.push(chunk);
        } else if (s === '*** End of File' && chunk) {
          chunk.eof = true;
          chunk = undefined;
        } else if (s === '' || /^[ +\-]/.test(s)) {
          if (!chunk) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${at + 1}`);
            chunk = { anchor: '', eof: false, body: [] };
            chunks.push(chunk);
          }
          chunk.body.push({ kind: s === '' ? ' ' : s[0] as BodyLine['kind'], text: s.slice(1) });
        } else throw new Exit2(`error: parse ${at + 1}`);
      }
      if (chunks.length === 0 && !move) throw new Exit2(`error: parse ${sectionLine}`);
    }
    edits.push((tree) => {
      checkPaths(move ? [p, next] : [p]);
      if (kind === 'Add') {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, writeLines({ lines: added, br: '\n', final: true }));
      } else {
        const file = existing(tree, p);
        if (kind === 'Delete') { tree.now.set(p, null); return; }
        if (move && tree.get(next) !== null) throw new Fail('exists', next);
        let cursor = 0;
        for (const chunk of chunks) {
          if (chunk.anchor !== '') {
            const found = occurrences(file.lines, [chunk.anchor], strict, cursor);
            if (found.positions.length === 0) throw new Fail('no-match', p);
            cursor = found.positions[0]! + 1;
          }
          const old = oldLines(chunk.body);
          let at = chunk.eof ? file.lines.length : cursor;
          let tier = 0;
          if (old.length > 0) {
            const found = occurrences(file.lines, old, strict, cursor, chunk.eof);
            if (found.positions.length === 0) throw new Fail('no-match', p);
            at = found.positions[0]!;
            tier = found.tier;
          }
          const added = replacement(chunk.body, file.lines.slice(at, at + old.length), old, tier);
          file.lines.splice(at, old.length, ...added);
          cursor = at + added.length;
        }
        storeUpdate(tree, p, next, file);
      }
    });
    i = end;
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
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchEdits(lines, strict)
      : v4aEdits(lines, strict);
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
  const rows = new Map<string, string>();
  const moved = new Set<string>();
  for (const { old, next } of tree.moves) {
    if (!moved.has(old) && !moved.has(next) && tree.original(old) !== null && tree.get(old) === null && tree.original(next) === null && tree.get(next) !== null) {
      rows.set(next, `R ${old} -> ${next}`);
      moved.add(old);
      moved.add(next);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!moved.has(p)) rows.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  const output = [...rows].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(([, row]) => row);
  return { code: 0, out: [...output, `ok: ${rows.size} ${rows.size === 1 ? 'file' : 'files'}`] };
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
