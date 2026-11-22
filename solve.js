// solve.js — fast drop-in for makefun-site 1.0.0 (Build a static site faster).
// Reimplemented from the makefun-site README spec: own front matter, template
// dialect, Markdown subset, slug rule and report. Dependency-free, no eval,
// no dynamic import, no environment reads: pure function of its input.
//
// export: run(input) -> { <output path>: <file text>, ... } for one case
//   input = { site: { title, base_url, per_page, recent },
//             templates: { <name>: <source> },
//             files: [{ path, content }] }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// Code-unit order, the only order this program sorts by.
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

const AMP = 38, LT = 60, GT = 62, QUOT = 34, APOS = 39;

// HTML escape: & < > " ' only. Fast path when nothing needs escaping.
function escInto(out, s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 &&
      s.indexOf('"') < 0 && s.indexOf("'") < 0) { out.push(s); return; }
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === AMP) rep = '&amp;';
    else if (c === LT) rep = '&lt;';
    else if (c === GT) rep = '&gt;';
    else if (c === QUOT) rep = '&quot;';
    else if (c === APOS) rep = '&#39;';
    if (rep !== null) {
      if (start < i) out.push(s.slice(start, i));
      out.push(rep);
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
}

function esc(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 &&
      s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  const out = [];
  escInto(out, s);
  return out.join('');
}

// Slug rule: NFKD, drop combining marks, A-Z lowered, each run of
// non [a-z0-9] one '-', none at either end, cut to 64 chars (a '-' left
// at the cut dropped), 'untitled' when nothing is left.
// Pure-ASCII input is identical under NFKD, so it takes a fast path.
const MARK_RE = /\p{M}/gu;
function slugifyRaw(s) {
  let t = s;
  let ascii = true;
  for (let i = 0; i < t.length; i++) {
    if (t.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) t = t.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let dash = false;
  for (let i = 0; i < t.length; i++) {
    let c = t.charCodeAt(i);
    if (c >= 65 && c <= 90) c += 32;
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) { out += String.fromCharCode(c); dash = false; }
    else if (!dash && out.length > 0) { out += '-'; dash = true; }
  }
  if (out.length > 64) {
    out = out.slice(0, 64);
    if (out.charCodeAt(63) === 45) out = out.slice(0, 63);
  } else if (dash) {
    out = out.slice(0, -1);
  }
  return out.length === 0 ? 'untitled' : out;
}

function dateLong(ds) {
  if (!ds) return '';
  const y = ds.slice(0, 4);
  const m = (ds.charCodeAt(5) - 48) * 10 + (ds.charCodeAt(6) - 48);
  let d = ds.slice(8, 10);
  if (d.charCodeAt(0) === 48) d = d.slice(1);
  return d + ' ' + MONTHS[m - 1] + ' ' + y;
}

// Template truthiness: undefined, null, false, "", 0, empty array are false.
function truthy(v) {
  if (v === undefined || v === null || v === false || v === '' || v === 0) return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

// Write a template value: string as-is, number in JS digits, true/false,
// array as its items written joined by ', ', anything else ''.
// escape=true HTML-escapes string items ({{ }}), false writes raw ({{{ }}}).
function writeVal(out, v, escape) {
  if (typeof v === 'string') {
    if (escape) escInto(out, v);
    else out.push(v);
  } else if (typeof v === 'number') {
    out.push(String(v));
  } else if (v === true) {
    out.push('true');
  } else if (v === false) {
    out.push('false');
  } else if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out.push(', ');
      writeVal(out, v[i], escape);
    }
  }
}

// Resolve a dotted path against a scope chain. First name: innermost loop
// binding (loop before the element variable), else the top values object.
// Later names: an own property of the value so far, else undefined.
function resolvePath(scope, parts) {
  let v;
  const name0 = parts[0];
  let found = false;
  for (let s = scope; s !== null; s = s.parent) {
    if (s.loop && name0 === 'loop') { v = s.loop; found = true; break; }
    if (s.varName !== null && name0 === s.varName) { v = s.varVal; found = true; break; }
  }
  if (!found) {
    v = scope.top[name0];
    if (v === undefined && !Object.prototype.hasOwnProperty.call(scope.top, name0)) return undefined;
  }
  for (let i = 1; i < parts.length; i++) {
    if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return undefined;
    const k = parts[i];
    if (!Object.prototype.hasOwnProperty.call(v, k)) return undefined;
    v = v[k];
  }
  return v;
}

// ---------- Front matter ----------
// A source opens on the line `---` and runs to the next line exactly `---`.
// Lines between are blank, a `#` comment, or `key: value` (key a-z + `_`,
// colon, one space, value, trailing spaces/tabs dropped). The first failing
// line is reported; then a source with no title is refused.

function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function validDate(s) {
  if (s.length !== 10) return false;
  for (let i = 0; i < 10; i++) {
    const c = s.charCodeAt(i);
    if (i === 4 || i === 7) { if (c !== 45) return false; }
    else if (c < 48 || c > 57) return false;
  }
  const y = (s.charCodeAt(0) - 48) * 1000 + (s.charCodeAt(1) - 48) * 100 +
    (s.charCodeAt(2) - 48) * 10 + (s.charCodeAt(3) - 48);
  const m = (s.charCodeAt(5) - 48) * 10 + (s.charCodeAt(6) - 48);
  const d = (s.charCodeAt(8) - 48) * 10 + (s.charCodeAt(9) - 48);
  if (y < 1970 || y > 2099 || m < 1 || m > 12) return false;
  let dim = DAYS_IN_MONTH[m - 1];
  if (m === 2 && isLeap(y)) dim = 29;
  return d >= 1 && d <= dim;
}

function trimEndST(s) {
  let e = s.length;
  while (e > 0) {
    const c = s.charCodeAt(e - 1);
    if (c === 32 || c === 9) e--;
    else break;
  }
  return e === s.length ? s : s.slice(0, e);
}

function trimST(s) {
  let a = 0;
  let e = s.length;
  while (a < e) {
    const c = s.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (e > a) {
    const c = s.charCodeAt(e - 1);
    if (c === 32 || c === 9) e--;
    else break;
  }
  return s.slice(a, e);
}

// title / summary: quoted ("...", escapes only \" and \\) or bare (never
// opening on " or [). Returns the value, or an error reason string.
function parseStringValue(raw) {
  if (raw.charCodeAt(0) === 34) {
    let out = '';
    let start = 1;
    for (let i = 1; i < raw.length; i++) {
      const c = raw.charCodeAt(i);
      if (c === 92) {
        if (i + 1 >= raw.length) return { error: 'a quoted string is not closed' };
        const n = raw.charCodeAt(i + 1);
        if (n !== 34 && n !== 92) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += raw.slice(start, i) + raw[i + 1];
        i++;
        start = i + 1;
      } else if (c === 34) {
        if (i !== raw.length - 1) return { error: 'a quoted string is not closed' };
        out += raw.slice(start, i);
        return { value: out };
      }
    }
    return { error: 'a quoted string is not closed' };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

// tags: [a, b, c]; each name trimmed, none empty or holding " [ ].
function parseTagsValue(raw) {
  if (raw.length < 2 || raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
    return { error: 'not a list [a, b]' };
  }
  const inner = raw.slice(1, -1);
  if (trimST(inner) === '') return { value: [] };
  const parts = inner.split(',');
  const tags = [];
  for (let i = 0; i < parts.length; i++) {
    const t = trimST(parts[i]);
    if (t === '' || t.indexOf('"') >= 0 || t.indexOf('[') >= 0 || t.indexOf(']') >= 0) {
      return { error: 'an empty tag, or one holding " [ or ]' };
    }
    tags.push(t);
  }
  return { value: tags };
}

function validLayoutName(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return true;
}

function validSlugKey(s) {
  if (s.length === 0 || s.length > 64) return false;
  let prevDash = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 97 && c <= 122) { prevDash = false; continue; }
    if (c >= 48 && c <= 57) { prevDash = false; continue; }
    if (c === 45 && !prevDash) { prevDash = true; continue; }
    return false;
  }
  return !prevDash;
}

// Returns { fm, body } or { error } where error is the reason after `refused <path>: `.
function parseFrontMatter(content) {
  const nl = content.indexOf('\n');
  const first = nl < 0 ? content : content.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  // Find the closing line, exactly `---`.
  let pos = nl < 0 ? content.length : nl + 1;
  let closeStart = -1;
  let bodyStart = content.length;
  while (pos <= content.length) {
    const eol = content.indexOf('\n', pos);
    const lineEnd = eol < 0 ? content.length : eol;
    if (content.slice(pos, lineEnd) === '---') {
      closeStart = pos;
      bodyStart = eol < 0 ? content.length : eol + 1;
      break;
    }
    if (eol < 0) break;
    pos = eol + 1;
  }
  if (closeStart < 0) return { error: 'the front matter is not closed' };
  const fm = { title: undefined, summary: undefined, date: undefined, tags: undefined, draft: undefined, layout: undefined, slug: undefined };
  const seen = {};
  let lineNo = 2;
  pos = nl < 0 ? content.length : nl + 1;
  while (pos < closeStart) {
    const eol = content.indexOf('\n', pos);
    const lineEnd = eol < 0 ? closeStart : Math.min(eol, closeStart);
    const line = content.slice(pos, lineEnd);
    // Blank (spaces/tabs only) or a `#` comment.
    let p = 0;
    while (p < line.length && (line.charCodeAt(p) === 32 || line.charCodeAt(p) === 9)) p++;
    if (p === line.length || line.charCodeAt(p) === 35) {
      lineNo++;
      pos = eol < 0 ? content.length : eol + 1;
      continue;
    }
    // key: a-z + _ then ':'.
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) {
      return { error: 'line ' + lineNo + ' is not "key: value"' };
    }
    const key = line.slice(0, k);
    const rest = line.slice(k + 1);
    let value;
    if (rest === '') {
      return { error: 'key "' + key + '" has no value' };
    }
    if (rest.charCodeAt(0) !== 32) {
      return { error: 'line ' + lineNo + ' is not "key: value"' };
    }
    value = trimEndST(rest.slice(1));
    if (value === '') return { error: 'key "' + key + '" has no value' };
    if (key !== 'title' && key !== 'summary' && key !== 'date' && key !== 'tags' && key !== 'draft' && key !== 'layout' && key !== 'slug') {
      return { error: 'unknown key "' + key + '"' };
    }
    if (seen[key]) return { error: 'key "' + key + '" is given twice' };
    seen[key] = true;
    if (key === 'title' || key === 'summary') {
      const r = parseStringValue(value);
      if (r.error) return { error: 'key "' + key + '": ' + r.error };
      fm[key] = r.value;
    } else if (key === 'date') {
      if (!validDate(value)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      fm.date = value;
    } else if (key === 'tags') {
      const r = parseTagsValue(value);
      if (r.error) return { error: 'key "tags": ' + r.error };
      fm.tags = r.value;
    } else if (key === 'draft') {
      if (value !== 'true' && value !== 'false') return { error: 'key "draft": true or false' };
      fm.draft = value === 'true';
    } else if (key === 'layout') {
      if (!validLayoutName(value)) return { error: 'key "layout": not a template name' };
      fm.layout = value;
    } else if (key === 'slug') {
      if (!validSlugKey(value)) return { error: 'key "slug": not a slug' };
      fm.slug = value;
    }
    lineNo++;
    pos = eol < 0 ? content.length : eol + 1;
  }
  if (fm.title === undefined) return { error: 'no title' };
  return { fm, body: content.slice(bodyStart) };
}

// ---------- Templates ----------
// Ops: [0, text] [1, parts] escaped [2, parts] raw
//      [3, parts, neg, thenOps, elseOps|null]  [4, varName, parts, bodyOps]
//      [5, name] include
// A {% %} tag alone on its line (only spaces/tabs beside it) takes the whole
// line with it, its \n included. Text, {{ }} and {{{ }}} never do.

function validPathParts(inner) {
  if (inner.length === 0) return null;
  const parts = inner.split('.');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length === 0) return null;
    const c0 = p.charCodeAt(0);
    if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 95)) return null;
    for (let j = 1; j < p.length; j++) {
      const c = p.charCodeAt(j);
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95)) return null;
    }
  }
  return parts;
}

function trimWS(s) {
  let a = 0;
  let e = s.length;
  while (a < e) {
    const c = s.charCodeAt(a);
    if (c === 32 || c === 9 || c === 10 || c === 13) a++;
    else break;
  }
  while (e > a) {
    const c = s.charCodeAt(e - 1);
    if (c === 32 || c === 9 || c === 10 || c === 13) e--;
    else break;
  }
  return s.slice(a, e);
}

// Compile one template source. Returns { ops, reads } or { error }.
function compileTemplate(src) {
  const root = { kind: 'root', ops: [] };
  const stack = [root];
  let text = '';
  const flushText = () => {
    if (text.length > 0) {
      // Text goes to the branch currently open (elseOps after an else).
      curOps().push([0, text]);
      text = '';
    }
  };
  const curOps = () => {
    const f = stack[stack.length - 1];
    return f.kind === 'if' && f.inElse ? f.elseOps : f.ops;
  };
  const pushOp = (op) => { curOps().push(op); };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src.charCodeAt(i);
    // Find the next tag start.
    if (c === 123 && i + 1 < n && (src.charCodeAt(i + 1) === 123 || src.charCodeAt(i + 1) === 37)) {
      const isRaw = src.charCodeAt(i + 1) === 123 && i + 2 < n && src.charCodeAt(i + 2) === 123;
      const isVar = src.charCodeAt(i + 1) === 123;
      if (isVar) {
        const close = isRaw ? src.indexOf('}}}', i + 3) : src.indexOf('}}', i + 2);
        if (close < 0) return { error: isRaw ? 'a {{{ is not closed' : 'a {{ is not closed' };
        const inner = trimWS(src.slice(isRaw ? i + 3 : i + 2, close));
        const parts = validPathParts(inner);
        if (!parts) return { error: '"' + inner + '" is not a path' };
        flushText();
        pushOp([isRaw ? 2 : 1, parts]);
        i = close + (isRaw ? 3 : 2);
        continue;
      }
      // {% ... %}
      const close = src.indexOf('%}', i + 2);
      if (close < 0) return { error: 'a {% is not closed' };
      const inner = trimWS(src.slice(i + 2, close));
      const tagEnd = close + 2;
      // Line-alone check: only spaces/tabs beside the tag on its line.
      let alone = true;
      for (let j = i - 1; j >= 0; j--) {
        const ch = src.charCodeAt(j);
        if (ch === 10) break;
        if (ch !== 32 && ch !== 9) { alone = false; break; }
      }
      if (alone) {
        for (let j = tagEnd; j < n; j++) {
          const ch = src.charCodeAt(j);
          if (ch === 10) break;
          if (ch !== 32 && ch !== 9) { alone = false; break; }
        }
      }
      if (alone) {
        // Drop the spaces/tabs before the tag on this line.
        let t = text.length;
        while (t > 0) {
          const ch = text.charCodeAt(t - 1);
          if (ch === 32 || ch === 9) t--;
          else break;
        }
        text = text.slice(0, t);
      }
      flushText();
      let m;
      if (inner === 'else') {
        const f = stack[stack.length - 1];
        if (f.kind !== 'if' || f.inElse) return { error: 'an else outside an if' };
        f.inElse = true;
        f.elseOps = [];
      } else if (inner === 'endif') {
        const f = stack[stack.length - 1];
        if (f.kind !== 'if') return { error: 'an endif with no open if' };
        stack.pop();
        pushOp([3, f.parts, f.neg, f.ops, f.elseOps]);
      } else if (inner === 'endfor') {
        const f = stack[stack.length - 1];
        if (f.kind !== 'for') return { error: 'an endfor with no open for' };
        stack.pop();
        pushOp([4, f.varName, f.parts, f.ops]);
      } else if ((m = /^for ([A-Za-z_][A-Za-z0-9_]*) in (.+)$/.exec(inner))) {
        const parts = validPathParts(trimWS(m[2]));
        if (!parts) return { error: '"' + trimWS(m[2]) + '" is not a path' };
        stack.push({ kind: 'for', varName: m[1], parts, ops: [] });
      } else if ((m = /^if (not )?(.+)$/.exec(inner))) {
        const parts = validPathParts(trimWS(m[2]));
        if (!parts) return { error: '"' + trimWS(m[2]) + '" is not a path' };
        stack.push({ kind: 'if', parts, neg: !!m[1], ops: [], elseOps: null, inElse: false });
      } else if ((m = /^include "([a-z0-9-]+)"$/.exec(inner))) {
        pushOp([5, m[1]]);
      } else {
        return { error: '{% ' + inner + ' %} is not a tag' };
      }
      i = tagEnd;
      if (alone && i < n && src.charCodeAt(i) === 10) i++;
      continue;
    }
    text += src[i];
    i++;
  }
  flushText();
  if (stack.length > 1) {
    const f = stack[stack.length - 1];
    return { error: f.kind === 'if' ? 'a if is not closed' : 'a for is not closed' };
  }
  return { ops: root.ops, reads: null };
}

// First names a template reads, transitively through includes, minus names
// its own for-loops bind (those are local). Used for the include cache key.
function computeReads(ops, templates, bound, visiting) {
  const reads = new Set();
  const walk = (list, boundSet) => {
    for (const op of list) {
      if (op[0] === 1 || op[0] === 2) {
        if (!boundSet.has(op[1][0])) reads.add(op[1][0]);
      } else if (op[0] === 3) {
        if (!boundSet.has(op[1][0])) reads.add(op[1][0]);
        walk(op[3], boundSet);
        if (op[4]) walk(op[4], boundSet);
      } else if (op[0] === 4) {
        if (!boundSet.has(op[2][0])) reads.add(op[2][0]);
        const inner = new Set(boundSet);
        inner.add(op[1]);
        inner.add('loop');
        walk(op[3], inner);
      } else if (op[0] === 5) {
        const tpl = templates.get(op[1]);
        if (tpl && !visiting.has(op[1])) {
          visiting.add(op[1]);
          const sub = computeReads(tpl.ops, templates, new Set(), visiting);
          visiting.delete(op[1]);
          for (const r of sub) if (!boundSet.has(r)) reads.add(r);
        }
      }
    }
  };
  walk(ops, bound);
  return reads;
}

// ---------- Template rendering ----------
// Includes render in the same scope. An include whose inputs (every value
// the included template reads, transitively) are identical to a render
// already done this case reuses that render: a card, a header, a footer is
// built once per distinct scope instead of once per page that shows it.

let objIdCounter = 1;
const objIds = new WeakMap();

function valueKey(v) {
  if (v === undefined || v === null) return 'u';
  if (typeof v === 'string') return 's' + v;
  if (typeof v === 'number') return 'n' + v;
  if (v === true) return 't';
  if (v === false) return 'f';
  let id = objIds.get(v);
  if (id === undefined) {
    id = objIdCounter++;
    objIds.set(v, id);
  }
  return 'o' + id;
}

function renderInclude(name, scope, ctx, out, depth) {
  const tpl = ctx.templates.get(name);
  if (!tpl) return;
  if (depth + 1 > 8) return;
  const reads = tpl.reads;
  let key;
  if (reads.length === 0) {
    key = name;
  } else {
    let k = name;
    for (let i = 0; i < reads.length; i++) {
      k += '\n' + reads[i] + '=' + valueKey(resolvePath(scope, [reads[i]]));
    }
    key = k;
  }
  const hit = ctx.includeCache.get(key);
  if (hit !== undefined) {
    out.push(hit);
    return;
  }
  const sub = [];
  renderOps(tpl.ops, scope, ctx, sub, depth + 1);
  const s = sub.join('');
  ctx.includeCache.set(key, s);
  out.push(s);
}

const EMPTY_OPS = [];

function renderOps(ops, scope, ctx, out, depth) {
  for (let oi = 0; oi < ops.length; oi++) {
    const op = ops[oi];
    const kind = op[0];
    if (kind === 0) {
      out.push(op[1]);
    } else if (kind === 1) {
      writeVal(out, resolvePath(scope, op[1]), true);
    } else if (kind === 2) {
      writeVal(out, resolvePath(scope, op[1]), false);
    } else if (kind === 3) {
      const v = resolvePath(scope, op[1]);
      const take = op[2] ? !truthy(v) : truthy(v);
      renderOps(take ? op[3] : (op[4] || EMPTY_OPS), scope, ctx, out, depth);
    } else if (kind === 4) {
      const arr = resolvePath(scope, op[2]);
      if (Array.isArray(arr)) {
        const len = arr.length;
        for (let i = 0; i < len; i++) {
          const loop = { index: i + 1, first: i === 0, last: i === len - 1, length: len };
          renderOps(op[3], { parent: scope, varName: op[1], varVal: arr[i], loop, top: scope.top }, ctx, out, depth);
        }
      }
    } else {
      renderInclude(op[1], scope, ctx, out, depth);
    }
  }
}

function renderTemplate(name, top, ctx) {
  const tpl = ctx.templates.get(name);
  if (!tpl) return null;
  const out = [];
  renderOps(tpl.ops, { parent: null, varName: null, varVal: undefined, loop: null, top }, ctx, out, 0);
  return out.join('');
}

// ---------- Markdown ----------
// Own dialect, not CommonMark. Blocks are read line by line; a paragraph's
// lines are joined by \n and inline-scanned as one string, so a construct
// may span the \n between two lines of one paragraph or list item.

function isEscapableCode(c) {
  return c === 96 || c === 92 || c === 42 || c === 95 || c === 91 || c === 93 ||
    c === 40 || c === 41 || c === 35 || c === 43 || c === 45 || c === 46 ||
    c === 33 || c === 62;
}

function isBlankLine(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Fence open: ``` + optional language [A-Za-z0-9_+ -]* + spaces/tabs only.
// Returns the language ('' when none) or null when the line is no fence.
function fenceOpen(s, a, b) {
  if (b - a < 3) return null;
  if (s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return null;
  let j = a + 3;
  while (j < b) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) j++;
    else break;
  }
  const lang = s.slice(a + 3, j);
  while (j < b) {
    const c = s.charCodeAt(j);
    if (c !== 32 && c !== 9) return null;
    j++;
  }
  return lang;
}

// Fence close: exactly ``` then spaces/tabs only.
function isFenceClose(s, a, b) {
  if (b - a < 3) return false;
  if (s.charCodeAt(a) !== 96 || s.charCodeAt(a + 1) !== 96 || s.charCodeAt(a + 2) !== 96) return false;
  for (let j = a + 3; j < b; j++) {
    const c = s.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Heading: 1-6 #, at least one space/tab, then text (trailing spaces/tabs
// dropped). Returns { level, textStart, textEnd } or null.
function headingAt(s, a, b) {
  let n = 0;
  while (n < 6 && a + n < b && s.charCodeAt(a + n) === 35) n++;
  if (n === 0) return null;
  if (a + n >= b) return null;
  const c = s.charCodeAt(a + n);
  if (c !== 32 && c !== 9) return null;
  let t = a + n;
  while (t < b) {
    const ch = s.charCodeAt(t);
    if (ch === 32 || ch === 9) t++;
    else break;
  }
  let e = b;
  while (e > t) {
    const ch = s.charCodeAt(e - 1);
    if (ch === 32 || ch === 9) e--;
    else break;
  }
  if (t >= e) return null;
  return { level: n, textStart: t, textEnd: e };
}

function isHr(s, a, b) {
  if (b - a < 3) return false;
  const c0 = s.charCodeAt(a);
  if (c0 !== 45 && c0 !== 42) return false;
  if (s.charCodeAt(a + 1) !== c0 || s.charCodeAt(a + 2) !== c0) return false;
  for (let j = a + 3; j < b; j++) {
    const c = s.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// List start: `- ` / `* ` (bullet) or digits + `. ` (ordered).
function listStart(s, a, b) {
  const c0 = s.charCodeAt(a);
  if (c0 === 45 || c0 === 42) {
    if (a + 1 < b && s.charCodeAt(a + 1) === 32) return { ordered: false, num: 0, contentStart: a + 2 };
    return null;
  }
  if (c0 >= 48 && c0 <= 57) {
    let j = a;
    while (j < b && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    if (j + 1 < b && s.charCodeAt(j) === 46 && s.charCodeAt(j + 1) === 32) {
      return { ordered: true, num: parseInt(s.slice(a, j), 10), contentStart: j + 2 };
    }
  }
  return null;
}

function uniqueSlug(slug, taken) {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  let i = 2;
  while (taken.has(slug + '-' + i)) i++;
  const r = slug + '-' + i;
  taken.add(r);
  return r;
}

// --- inline ---

function findCodeClose(s, from, b) {
  let j = from;
  while (j < b) {
    if (s.charCodeAt(j) === 96) {
      if (j - from >= 1) return j;
      return -1;
    }
    j++;
  }
  return -1;
}

function findStrongClose(s, from, b) {
  let j = from;
  while (j + 1 < b) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < b && isEscapableCode(s.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === 42 && s.charCodeAt(j + 1) === 42) {
      if (j - from >= 1) return j;
      return -1;
    }
    j++;
  }
  return -1;
}

// Em closer: the next unescaped single '*'. A '**' is a strong delimiter,
// not a single star: the scan steps over the whole pair and keeps going.
// (In `*quick***` that lands on the last star, content `quick**`; in
// `*a**b*` it skips the pair and closes after `b`.)
function findEmClose(s, from, b) {
  let j = from;
  while (j < b) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < b && isEscapableCode(s.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === 42) {
      if (j + 1 < b && s.charCodeAt(j + 1) === 42) { j += 2; continue; }
      if (j - from >= 1) return j;
      return -1;
    }
    j++;
  }
  return -1;
}

function resolveLink(target, ctx, dir, sourcePath) {
  const c0 = target.charCodeAt(0);
  if (c0 === 35 || c0 === 47) return target;
  const colon = target.indexOf(':');
  if (colon > 0) {
    let ok = true;
    const f = target.charCodeAt(0);
    if (!((f >= 65 && f <= 90) || (f >= 97 && f <= 122))) ok = false;
    for (let i = 1; i < colon && ok; i++) {
      const ch = target.charCodeAt(i);
      if (!((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57) || ch === 43 || ch === 45 || ch === 46)) ok = false;
    }
    if (ok) return target;
  }
  let pathPart = target;
  let frag = null;
  const hash = target.indexOf('#');
  if (hash >= 0) {
    pathPart = target.slice(0, hash);
    frag = target.slice(hash + 1);
  }
  const stack = dir === '' ? [] : dir.split('/');
  const segs = pathPart.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length === 0) return brokenLink(target, ctx, sourcePath);
      stack.pop();
    } else {
      stack.push(seg);
    }
  }
  const resolved = stack.join('/');
  const url = ctx.pageBySource.get(resolved);
  if (url !== undefined) return url + (frag !== null ? '#' + frag : '');
  if (ctx.staticSet.has(resolved)) return ctx.base + '/' + resolved + (frag !== null ? '#' + frag : '');
  return brokenLink(target, ctx, sourcePath);
}

function brokenLink(target, ctx, sourcePath) {
  const key = sourcePath + '\n' + target;
  if (!ctx.brokenSeen.has(key)) {
    ctx.brokenSeen.add(key);
    ctx.report.push('broken-link ' + sourcePath + ' -> ' + target);
  }
  return target;
}

// Try to read a link starting at s[i] === '['. Returns null or
// { textStart, textEnd, href, end }.
function tryLink(s, i, b, ctx, dir, sourcePath) {
  let j = i + 1;
  let textEnd = -1;
  while (j < b) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < b && isEscapableCode(s.charCodeAt(j + 1))) { j += 2; continue; }
    if (c === 93) { textEnd = j; break; }
    j++;
  }
  if (textEnd < 0) return null;
  if (textEnd + 1 >= b || s.charCodeAt(textEnd + 1) !== 40) return null;
  let k = textEnd + 2;
  let targetEnd = -1;
  while (k < b) {
    if (s.charCodeAt(k) === 41) { targetEnd = k; break; }
    k++;
  }
  if (targetEnd < 0) return null;
  const target = s.slice(textEnd + 2, targetEnd);
  if (target.length === 0) return null;
  for (let t = 0; t < target.length; t++) {
    const c = target.charCodeAt(t);
    if (c === 32 || c === 9 || c === 10 || c === 13) return null;
  }
  return { textStart: i + 1, textEnd, href: resolveLink(target, ctx, dir, sourcePath), end: targetEnd + 1 };
}

function inlineRange(out, s, a, b, ctx, dir, sourcePath) {
  let i = a;
  let textStart = a;
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < b && isEscapableCode(s.charCodeAt(i + 1))) {
        if (i > textStart) escInto(out, s.slice(textStart, i));
        escInto(out, s[i + 1]);
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 96) {
      const close = findCodeClose(s, i + 1, b);
      if (close > 0) {
        if (i > textStart) escInto(out, s.slice(textStart, i));
        out.push('<code>');
        escInto(out, s.slice(i + 1, close));
        out.push('</code>');
        i = close + 1;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 42) {
      if (i + 1 < b && s.charCodeAt(i + 1) === 42) {
        const close = findStrongClose(s, i + 2, b);
        if (close > 0) {
          if (i > textStart) escInto(out, s.slice(textStart, i));
          out.push('<strong>');
          inlineRange(out, s, i + 2, close, ctx, dir, sourcePath);
          out.push('</strong>');
          i = close + 2;
          textStart = i;
          continue;
        }
        i += 2;
        continue;
      }
      const close = findEmClose(s, i + 1, b);
      if (close > 0) {
        if (i > textStart) escInto(out, s.slice(textStart, i));
        out.push('<em>');
        inlineRange(out, s, i + 1, close, ctx, dir, sourcePath);
        out.push('</em>');
        i = close + 1;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 91) {
      const link = tryLink(s, i, b, ctx, dir, sourcePath);
      if (link) {
        if (i > textStart) escInto(out, s.slice(textStart, i));
        out.push('<a href="');
        escInto(out, link.href);
        out.push('">');
        inlineRange(out, s, link.textStart, link.textEnd, ctx, dir, sourcePath);
        out.push('</a>');
        i = link.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  if (b > textStart) escInto(out, s.slice(textStart, b));
}

// Render one body to HTML. Returns { html, toc, excerpt }.
function renderMarkdown(body, ctx, sourceDir, sourcePath) {
  const out = [];
  const toc = [];
  let excerpt = null;
  const headingIds = new Set();
  const n = body.length;
  let pos = 0;
  while (pos <= n) {
    const eol = body.indexOf('\n', pos);
    const le = eol < 0 ? n : eol;
    const nextPos = eol < 0 ? n + 1 : eol + 1;
    if (isBlankLine(body, pos, le)) {
      pos = nextPos;
      continue;
    }
    const c0 = body.charCodeAt(pos);
    // Fence.
    if (c0 === 96) {
      const lang = fenceOpen(body, pos, le);
      if (lang !== null) {
        out.push('<pre><code' + (lang ? ' class="language-' + lang + '"' : '') + '>');
        pos = nextPos;
        while (pos <= n) {
          const e2 = body.indexOf('\n', pos);
          const le2 = e2 < 0 ? n : e2;
          if (isFenceClose(body, pos, le2)) {
            pos = e2 < 0 ? n + 1 : e2 + 1;
            break;
          }
          escInto(out, body.slice(pos, le2));
          out.push('\n');
          if (e2 < 0) { pos = n + 1; break; }
          pos = e2 + 1;
        }
        out.push('</code></pre>\n');
        continue;
      }
    }
    // Heading.
    if (c0 === 35) {
      const h = headingAt(body, pos, le);
      if (h) {
        const id = uniqueSlug(slugifyCached(ctx, body.slice(h.textStart, h.textEnd)), headingIds);
        const inner = [];
        inlineRange(inner, body, h.textStart, h.textEnd, ctx, sourceDir, sourcePath);
        const innerHtml = inner.join('');
        out.push('<h' + h.level + ' id="' + id + '">' + innerHtml + '</h' + h.level + '>\n');
        if (h.level === 2 || h.level === 3) toc.push({ level: h.level, id, html: innerHtml });
        pos = nextPos;
        continue;
      }
    }
    // Thematic break.
    if ((c0 === 45 || c0 === 42) && isHr(body, pos, le)) {
      out.push('<hr>\n');
      pos = nextPos;
      continue;
    }
    // Blockquote.
    if (c0 === 62) {
      const lines = [];
      while (pos <= n) {
        const e2 = body.indexOf('\n', pos);
        const le2 = e2 < 0 ? n : e2;
        if (body.charCodeAt(pos) !== 62) break;
        let t = pos + 1;
        if (t < le2 && body.charCodeAt(t) === 32) t++;
        const trimmed = trimST(body.slice(t, le2));
        if (trimmed !== '') lines.push(trimmed);
        if (e2 < 0) { pos = n + 1; break; }
        pos = e2 + 1;
      }
      out.push('<blockquote>\n');
      if (lines.length > 0) {
        const joined = lines.join('\n');
        out.push('<p>');
        inlineRange(out, joined, 0, joined.length, ctx, sourceDir, sourcePath);
        out.push('</p>\n');
      }
      out.push('</blockquote>\n');
      continue;
    }
    // List.
    const ls = listStart(body, pos, le);
    if (ls) {
      const ordered = ls.ordered;
      out.push(ordered ? (ls.num !== 1 ? '<ol start="' + ls.num + '">' : '<ol>') : '<ul>');
      out.push('\n');
      let cur = [trimEndST(body.slice(ls.contentStart, le))];
      pos = nextPos;
      const flushItem = () => {
        const text = cur.join('\n');
        out.push('<li>');
        inlineRange(out, text, 0, text.length, ctx, sourceDir, sourcePath);
        out.push('</li>\n');
      };
      while (pos <= n) {
        const e2 = body.indexOf('\n', pos);
        const le2 = e2 < 0 ? n : e2;
        const next2 = e2 < 0 ? n + 1 : e2 + 1;
        if (isBlankLine(body, pos, le2)) break;
        const ls2 = listStart(body, pos, le2);
        if (ls2 && ls2.ordered === ordered) {
          flushItem();
          cur = [trimEndST(body.slice(ls2.contentStart, le2))];
          pos = next2;
          continue;
        }
        // Continuation: two or more spaces, then a non-space, non-tab.
        // A tab anywhere in the leading run breaks it.
        let lead = 0;
        while (pos + lead < le2 && body.charCodeAt(pos + lead) === 32) lead++;
        if (lead >= 2 && pos + lead < le2) {
          const ch = body.charCodeAt(pos + lead);
          if (ch !== 32 && ch !== 9) {
            cur.push(trimST(body.slice(pos, le2)));
            pos = next2;
            continue;
          }
        }
        break;
      }
      flushItem();
      out.push(ordered ? '</ol>\n' : '</ul>\n');
      continue;
    }
    // Paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break.
    const pLines = [trimST(body.slice(pos, le))];
    pos = nextPos;
    while (pos <= n) {
      const e2 = body.indexOf('\n', pos);
      const le2 = e2 < 0 ? n : e2;
      const next2 = e2 < 0 ? n + 1 : e2 + 1;
      if (isBlankLine(body, pos, le2)) break;
      const c2 = body.charCodeAt(pos);
      if (c2 === 96 && fenceOpen(body, pos, le2) !== null) break;
      if (c2 === 35 && headingAt(body, pos, le2)) break;
      if ((c2 === 45 || c2 === 42) && isHr(body, pos, le2)) break;
      pLines.push(trimST(body.slice(pos, le2)));
      pos = next2;
    }
    const text = pLines.join('\n');
    const inner = [];
    inlineRange(inner, text, 0, text.length, ctx, sourceDir, sourcePath);
    const innerHtml = inner.join('');
    if (excerpt === null) excerpt = innerHtml;
    out.push('<p>' + innerHtml + '</p>\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt === null ? '' : excerpt };
}

// ---------- Build pipeline ----------

function stripTrailingSlashes(s) {
  let e = s.length;
  while (e > 0 && s.charCodeAt(e - 1) === 47) e--;
  return s.slice(0, e);
}

function sourceDirOf(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function slugifyCached(ctx, text) {
  let s = ctx.slugCache.get(text);
  if (s === undefined) {
    s = slugifyRaw(text);
    ctx.slugCache.set(text, s);
  }
  return s;
}

function isWSCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 160 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 ||
    c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

// Words are runs of non-whitespace over the raw body.
function countWords(body) {
  let words = 0;
  let inWord = false;
  for (let i = 0; i < body.length; i++) {
    if (isWSCode(body.charCodeAt(i))) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      words++;
    }
  }
  return words;
}

export function run(input) {
  const site = input.site;
  const base = stripTrailingSlashes(site.base_url);
  const ctx = {
    templates: new Map(),
    includeCache: new Map(),
    slugCache: new Map(),
    brokenSeen: new Set(),
    report: [],
    pageBySource: new Map(),
    staticSet: new Set(),
    base,
  };
  // 1. Sources, sorted by path in code-unit order.
  const files = input.files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) sources.push(f);
    else {
      statics.push(f);
      ctx.staticSet.add(f.path);
    }
  }
  // 2. Templates, parsed in code-unit order of name. One that does not
  // parse is reported and left out, as if it were not there.
  const templateNames = Object.keys(input.templates).sort();
  for (let i = 0; i < templateNames.length; i++) {
    const name = templateNames[i];
    const compiled = compileTemplate(input.templates[name]);
    if (compiled.error) {
      ctx.report.push('template "' + name + '": ' + compiled.error);
    } else {
      ctx.templates.set(name, compiled);
    }
  }
  for (const tpl of ctx.templates.values()) {
    tpl.reads = Array.from(computeReads(tpl.ops, ctx.templates, new Set(), new Set())).sort();
  }
  // 3. Front matter and source checks, in source order. First failure wins.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const f = sources[i];
    const path = f.path;
    const content = f.content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const parsed = parseFrontMatter(content);
    if (parsed.error) {
      ctx.report.push('refused ' + path + ': ' + parsed.error);
      continue;
    }
    const fm = parsed.fm;
    if (path.startsWith('tags/') || path.startsWith('page/')) {
      ctx.report.push('refused ' + path + ': ' + path.slice(0, path.indexOf('/')) + '/ is the generator\'s own');
      continue;
    }
    const isPost = path.startsWith('posts/');
    if (isPost && fm.date === undefined) {
      ctx.report.push('refused ' + path + ': a post needs a date');
      continue;
    }
    const layoutName = fm.layout !== undefined ? fm.layout : (isPost ? 'post' : 'page');
    if (!ctx.templates.has(layoutName)) {
      ctx.report.push('refused ' + path + ': layout "' + layoutName + '" is no template that parses');
      continue;
    }
    if (fm.draft === true) {
      ctx.report.push('draft ' + path);
      continue;
    }
    kept.push({ path, fm, body: parsed.body, isPost, layoutName, srcDir: sourceDirOf(path) });
  }
  // 4. Permalinks, in source order. At the root, posts, tags and page are
  // taken from the start.
  const takenByDir = new Map();
  takenByDir.set('', new Set(['posts', 'tags', 'page']));
  const dirTaken = (dir) => {
    let t = takenByDir.get(dir);
    if (!t) {
      t = new Set();
      takenByDir.set(dir, t);
    }
    return t;
  };
  for (let i = 0; i < kept.length; i++) {
    const k = kept[i];
    const dir = k.isPost ? 'posts' : k.srcDir;
    const baseSlug = k.fm.slug !== undefined ? k.fm.slug : slugifyCached(ctx, k.fm.title);
    const slug = uniqueSlug(baseSlug, dirTaken(dir));
    k.dir = dir;
    k.slug = slug;
    k.outputPath = (dir === '' ? '' : dir + '/') + slug + '/index.html';
    k.url = base + '/' + (dir === '' ? '' : dir + '/') + slug + '/';
    ctx.pageBySource.set(k.path, k.url);
  }
  // 5. Markdown, each kept source's body rendered to HTML, its links
  // resolved from the source's directory.
  for (let i = 0; i < kept.length; i++) {
    const k = kept[i];
    const md = renderMarkdown(k.body, ctx, k.srcDir, k.path);
    k.content = md.html;
    k.toc = md.toc;
    k.excerpt = md.excerpt;
    k.readingMinutes = Math.max(1, Math.ceil(countWords(k.body) / 200));
  }
  // 6. Collections: posts newest date first, equal dates by slug.
  const posts = [];
  for (let i = 0; i < kept.length; i++) if (kept[i].isPost) posts.push(kept[i]);
  posts.sort((a, b) => {
    if (a.fm.date !== b.fm.date) return a.fm.date < b.fm.date ? 1 : -1;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });
  // 7. Tags: walk the posts in collection order, each post's tags in its
  // own order, each slug once (the first spelling kept).
  const tagBySlug = new Map();
  const tags = [];
  for (let i = 0; i < kept.length; i++) {
    const k = kept[i];
    const seen = new Set();
    const deduped = [];
    const fmTags = k.fm.tags || [];
    for (let j = 0; j < fmTags.length; j++) {
      const name = fmTags[j];
      const slug = slugifyCached(ctx, name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      deduped.push(name);
    }
    k.tagNames = deduped;
  }
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    for (let j = 0; j < p.tagNames.length; j++) {
      const name = p.tagNames[j];
      const slug = slugifyCached(ctx, name);
      let tag = tagBySlug.get(slug);
      if (!tag) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', count: 0, posts: [] };
        tagBySlug.set(slug, tag);
        tags.push(tag);
      }
      tag.count++;
      tag.posts.push(p);
    }
  }
  tags.sort((a, b) => b.count - a.count || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  // Cards: one per kept source, built once and shared by every page that
  // shows it.
  const makeCard = (k) => ({
    title: k.fm.title,
    url: k.url,
    date: k.fm.date !== undefined ? k.fm.date : '',
    date_long: k.fm.date !== undefined ? dateLong(k.fm.date) : '',
    summary: k.fm.summary !== undefined ? k.fm.summary : '',
    excerpt: k.excerpt,
    reading_minutes: k.readingMinutes,
    tags: k.tagNames.map((name) => {
      const slug = slugifyCached(ctx, name);
      const tag = tagBySlug.get(slug);
      return { name: tag ? tag.name : name, slug, url: tag ? tag.url : '' };
    }),
  });
  for (let i = 0; i < kept.length; i++) kept[i].card = makeCard(kept[i]);
  const siteVal = { title: site.title, base_url: base };
  const tagsVal = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.count }));
  const recentVal = posts.slice(0, site.recent).map((p) => p.card);
  const baseTop = { site: siteVal, tags: tagsVal, recent: recentVal };
  const output = {};
  // 8. Layouts.
  const postIndex = new Map();
  for (let i = 0; i < posts.length; i++) postIndex.set(posts[i], i);
  for (let i = 0; i < kept.length; i++) {
    const k = kept[i];
    let newer = null;
    let older = null;
    if (k.isPost) {
      const idx = postIndex.get(k);
      if (idx > 0) {
        const p = posts[idx - 1];
        newer = { title: p.fm.title, url: p.url, date: p.fm.date, date_long: dateLong(p.fm.date) };
      }
      if (idx < posts.length - 1) {
        const p = posts[idx + 1];
        older = { title: p.fm.title, url: p.url, date: p.fm.date, date_long: dateLong(p.fm.date) };
      }
    }
    const page = { ...k.card, slug: k.slug, content: k.content, toc: k.toc, newer, older, is_post: k.isPost };
    const html = renderTemplate(k.layoutName, { ...baseTop, page }, ctx);
    if (html !== null) output[k.outputPath] = html;
  }
  if (ctx.templates.has('index')) {
    const perPage = site.per_page;
    const total = Math.max(1, Math.ceil(posts.length / perPage));
    for (let n = 1; n <= total; n++) {
      const pagePosts = posts.slice((n - 1) * perPage, n * perPage).map((p) => p.card);
      const pager = {
        number: n,
        total,
        url: n === 1 ? base + '/' : base + '/page/' + n + '/',
        newer_url: n === 1 ? '' : (n === 2 ? base + '/' : base + '/page/' + (n - 1) + '/'),
        older_url: n === total ? '' : base + '/page/' + (n + 1) + '/',
      };
      const html = renderTemplate('index', { ...baseTop, posts: pagePosts, pager }, ctx);
      if (html !== null) output[n === 1 ? 'index.html' : 'page/' + n + '/index.html'] = html;
    }
  }
  if (ctx.templates.has('tag')) {
    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      const tagVal = { name: t.name, slug: t.slug, url: t.url, count: t.count, posts: t.posts.map((p) => p.card) };
      const html = renderTemplate('tag', { ...baseTop, tag: tagVal }, ctx);
      if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
    }
  }
  if (ctx.templates.has('tags')) {
    const html = renderTemplate('tags', { ...baseTop }, ctx);
    if (html !== null) output['tags/index.html'] = html;
  }
  let staticCount = 0;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    staticCount++;
    if (Object.prototype.hasOwnProperty.call(output, f.path)) {
      ctx.report.push('shadowed ' + f.path + ': a built page has its path');
    } else {
      output[f.path] = f.content;
    }
  }
  // 9. The report.
  let pages = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].isPost) pages++;
  ctx.report.sort();
  let reportText = '';
  for (let i = 0; i < ctx.report.length; i++) reportText += ctx.report[i] + '\n';
  reportText += 'built ' + pages + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + staticCount + ' static files\n';
  output['build-report.txt'] = reportText;
  return output;
}
