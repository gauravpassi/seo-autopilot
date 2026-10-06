/**
 * Small LCS diff for the approvals screen. Word-level for short strings, line-level for files.
 * O(n*m) memory, capped so a huge robots.txt can't freeze a phone: above the cap we fall back
 * to a prefix/suffix trim with one replaced middle block, which is still correct, just coarser.
 */
export type DiffOp = { op: "eq" | "del" | "ins"; text: string };

const CELL_CAP = 400_000;

function lcsDiff(a: string[], b: string[]): DiffOp[] {
  // trim common prefix / suffix first (cheap and usually most of the input)
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start);
  const tail = a.slice(endA);
  const A = a.slice(start, endA);
  const B = b.slice(start, endB);

  const out: DiffOp[] = [];
  const push = (op: DiffOp["op"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text;
    else out.push({ op, text });
  };
  head.forEach((t) => push("eq", t));

  if (A.length * B.length > CELL_CAP) {
    A.forEach((t) => push("del", t));
    B.forEach((t) => push("ins", t));
  } else {
    const n = A.length;
    const m = B.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) {
        push("eq", A[i]);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        push("del", A[i++]);
      } else {
        push("ins", B[j++]);
      }
    }
    while (i < n) push("del", A[i++]);
    while (j < m) push("ins", B[j++]);
  }
  tail.forEach((t) => push("eq", t));
  return out;
}

/** Split into words and whitespace runs; joining tokens restores the text exactly. */
function words(s: string): string[] {
  return s.match(/\s+|[^\s]+/g) ?? [];
}

export function diffWords(before: string, after: string): DiffOp[] {
  return lcsDiff(words(before), words(after));
}

/**
 * Ops for one side of a word diff ("before" keeps eq+del, "after" keeps eq+ins), with a lone
 * whitespace gap between two changed runs folded into the change so it reads as one chip.
 */
export function sideOps(ops: DiffOp[], side: "before" | "after"): DiffOp[] {
  const mark = side === "before" ? "del" : "ins";
  const xs = ops.filter((o) => o.op === "eq" || o.op === mark);
  const out: DiffOp[] = [];
  for (let i = 0; i < xs.length; i++) {
    const o = xs[i];
    const gap = o.op === "eq" && /^\s+$/.test(o.text) && xs[i - 1]?.op === mark && xs[i + 1]?.op === mark;
    const op = gap ? mark : o.op;
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += o.text;
    else out.push({ op, text: o.text });
  }
  return out;
}

export type LineOp = { op: "eq" | "del" | "ins"; line: string; a?: number; b?: number };

export function diffLines(before: string, after: string): LineOp[] {
  const A = before.replace(/\r\n/g, "\n").split("\n");
  const B = after.replace(/\r\n/g, "\n").split("\n");
  // diff on lines; lcsDiff merges adjacent tokens, so diff indexes directly instead
  const ops: LineOp[] = [];
  const tokensA = A.map((l) => l + "\n");
  const tokensB = B.map((l) => l + "\n");
  const merged = lcsDiff(tokensA, tokensB);
  let a = 1;
  let b = 1;
  for (const chunk of merged) {
    const lines = chunk.text.split("\n");
    lines.pop(); // trailing "" from final \n
    for (const line of lines) {
      if (chunk.op === "eq") ops.push({ op: "eq", line, a: a++, b: b++ });
      else if (chunk.op === "del") ops.push({ op: "del", line, a: a++ });
      else ops.push({ op: "ins", line, b: b++ });
    }
  }
  return ops;
}

/** Collapse long runs of unchanged lines, keeping `context` lines around changes. */
export function foldLines(ops: LineOp[], context = 3): Array<LineOp | { op: "fold"; count: number }> {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.op !== "eq") for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  if (!ops.some((o) => o.op !== "eq")) return ops.length > context * 2 ? [...ops.slice(0, context * 2), { op: "fold", count: ops.length - context * 2 }] : ops;
  const out: Array<LineOp | { op: "fold"; count: number }> = [];
  let skipped = 0;
  ops.forEach((o, i) => {
    if (keep[i]) {
      if (skipped) out.push({ op: "fold", count: skipped });
      skipped = 0;
      out.push(o);
    } else skipped++;
  });
  if (skipped) out.push({ op: "fold", count: skipped });
  return out;
}

/** Paths ("a.b[0].c") present in `after` but missing or different in `before`. */
export function changedJsonPaths(before: unknown, after: unknown, prefix = ""): { added: Set<string>; changed: Set<string> } {
  const added = new Set<string>();
  const changed = new Set<string>();
  const walk = (b: unknown, a: unknown, p: string) => {
    if (a && typeof a === "object" && !Array.isArray(a)) {
      const bo = b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : undefined;
      for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
        const path = p ? `${p}.${k}` : k;
        if (!bo || !(k in bo)) added.add(path);
        else walk(bo[k], v, path);
      }
    } else if (Array.isArray(a)) {
      const ba = Array.isArray(b) ? b : undefined;
      a.forEach((v, i) => {
        const path = `${p}[${i}]`;
        if (!ba || i >= ba.length) added.add(path);
        else walk(ba[i], v, path);
      });
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      changed.add(p);
    }
  };
  walk(before, after, prefix);
  return { added, changed };
}
