// Line-level diff for the prose-diff review. The agent's revision arrives as a
// whole new document; we diff it against what the user was looking at and present
// the changes as accept/reject hunks. Line granularity is robust for prose/markdown
// and maps cleanly onto "accept this change or keep the original."

// LCS over lines → a flat op stream (eq / del / add), in document order.
export function diffLines(before, after) {
  const a = before.split("\n"), b = after.split("\n");
  const n = a.length, m = b.length;
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: "eq", a: i, b: j }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "del", a: i }); i++; }
    else { ops.push({ t: "add", b: j }); j++; }
  }
  while (i < n) { ops.push({ t: "del", a: i }); i++; }
  while (j < m) { ops.push({ t: "add", b: j }); j++; }
  return ops;
}

// Group the op stream into ordered segments: unchanged runs ("eq") and change
// hunks ("hunk", carrying the removed `del` lines and added `add` lines). Each
// hunk gets a stable id so the UI can track accept/reject per hunk.
export function computeSegments(before, after) {
  const a = before.split("\n"), b = after.split("\n");
  const ops = diffLines(before, after);
  const segs = [];
  let eq = null, hunk = null, hid = 0;
  const flushEq = () => { if (eq) { segs.push({ type: "eq", lines: eq }); eq = null; } };
  const flushHunk = () => { if (hunk) { segs.push({ type: "hunk", id: ++hid, del: hunk.del, add: hunk.add }); hunk = null; } };
  for (const op of ops) {
    if (op.t === "eq") { flushHunk(); (eq = eq || []).push(a[op.a]); }
    else { flushEq(); hunk = hunk || { del: [], add: [] }; if (op.t === "del") hunk.del.push(a[op.a]); else hunk.add.push(b[op.b]); }
  }
  flushEq(); flushHunk();
  return segs;
}

// Reconstruct the document: unchanged runs pass through; each hunk contributes
// its `add` lines if accepted, else its original `del` lines.
export function applySegments(segs, acceptedIds) {
  const accepted = acceptedIds instanceof Set ? acceptedIds : new Set(acceptedIds || []);
  const out = [];
  for (const s of segs) {
    if (s.type === "eq") out.push(...s.lines);
    else out.push(...(accepted.has(s.id) ? s.add : s.del));
  }
  return out.join("\n");
}

export function hunkCount(segs) { return segs.filter((s) => s.type === "hunk").length; }
