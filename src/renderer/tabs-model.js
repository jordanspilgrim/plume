// Pure document-tab bookkeeping for in-window tab switching (#10).
// No DOM, no CodeMirror — the renderer owns presentation; this owns the list.
//
// A tab record:
//   { id, path, pendingName, text, savedText, sel, scrollTop }
// The ACTIVE tab's live state lives in the editor; its record is refreshed by
// the renderer on switch-away ("capture"). `text`/`savedText` are null for the
// active tab (live) and hold the captured buffer for background tabs.

let seq = 0;
export function createTab(partial = {}) {
  return {
    id: "t" + Date.now().toString(36) + "-" + (seq++).toString(36),
    path: null,
    pendingName: null,
    text: null,
    savedText: null,
    sel: null,
    scrollTop: 0,
    // Cluster A pillar 2: the tab's file could not be re-read (moved/deleted),
    // so its native binding was dropped. The buffer stays; the next save must
    // go through Save As — the stale path is never written blindly.
    unbound: false,
    ...partial,
  };
}

export function findTab(tabs, id) {
  return tabs.find((t) => t.id === id) || null;
}

export function addTab(tabs, tab, afterId = null) {
  const i = afterId ? tabs.findIndex((t) => t.id === afterId) : -1;
  if (i < 0) return [...tabs, tab];
  return [...tabs.slice(0, i + 1), tab, ...tabs.slice(i + 1)];
}

// Remove `id`; pick the neighbor that keeps the user's place (the tab to the
// right, else the new last tab) as the next active tab.
export function closeTab(tabs, id) {
  const i = tabs.findIndex((t) => t.id === id);
  if (i < 0) return { tabs, nextActiveId: null };
  const rest = tabs.filter((t) => t.id !== id);
  const next = rest.length ? rest[Math.min(i, rest.length - 1)] : null;
  return { tabs: rest, nextActiveId: next ? next.id : null };
}

// Cycle order: dir +1 = next (Ctrl-Tab), -1 = previous (Ctrl-Shift-Tab).
export function cycleTabId(tabs, activeId, dir) {
  if (tabs.length < 2) return activeId;
  const i = tabs.findIndex((t) => t.id === activeId);
  if (i < 0) return tabs[0].id;
  return tabs[(i + dir + tabs.length) % tabs.length].id;
}

export function tabDisplayName(tab) {
  if (tab.path) return tab.path.split("/").pop();
  return tab.pendingName || "Untitled";
}

// Dirty check for CAPTURED (background) tabs only — the active tab's dirty
// state is the editor's, which the renderer reads from its own title bar flag.
export function isCapturedDirty(tab) {
  return tab.text != null && tab.savedText != null && tab.text !== tab.savedText;
}

// A tab is a reusable blank scratch surface (safe to load a file into without
// clobbering anything) when it has no path and no captured content.
export function isBlankTab(tab) {
  return !tab.path && !(tab.text && tab.text.length);
}

// The user-initiated close decision (owner UAT decision 2026-07-27): a dirty
// doc always prompts Save / Don't Save / Cancel — never a silent write.
//   closeDecision({dirty, hasPath})            → "close" | "prompt"
//   closeDecision({dirty, hasPath}, choice)    → the action for that choice:
//     "save"    → "save-then-close" (has a path) | "saveas-then-close" (untitled)
//     "discard" → "close" (drop the buffer; nothing is written)
//     anything else (cancel / Escape / backdrop) → "stay"
// Both the window close-requested handler and the tab-close path route through
// this so the two prompts can never drift apart.
// SAVEFLOW: `isDraft` marks an Autosave-backed draft. A NON-EMPTY draft
// prompts on close REGARDLESS of dirty — it is autosaved-clean by then; the
// prompt is about it never having been deliberately saved (owner option B).
// Draft choices: save → graduate via Save As; discard → DELETE the draft file
// (deferred to confirmClose by the caller); cancel → stay.
export function closeDecision({ dirty, hasPath, isDraft = false, empty = false }, choice) {
  if (isDraft ? empty : !dirty) return "close";
  if (choice == null) return "prompt";
  if (choice === "save") return (hasPath && !isDraft) ? "save-then-close" : "saveas-then-close";
  if (choice === "discard") return isDraft ? "delete-draft-then-close" : "close";
  return "stay";
}

// Background tabs that still need a close decision when the WINDOW closes —
// every captured-dirty tab except the active one (the active doc is resolved
// live, first). Renderer-authoritative close: each of these gets its own
// Save / Don't Save / Cancel; none may be dropped silently.
// SAVEFLOW: "is a draft" is DERIVED from the path, never stored — the same
// anti-desync rule the native side follows (coord ruling, cluster-A lesson).
const DRAFT_DIR_RE = /\/Plume\/Autosave\//;
export function isDraftTab(tab) {
  return !!(tab && tab.path && DRAFT_DIR_RE.test(tab.path) && !tab.unbound);
}

export function dirtyBackgroundTabs(tabs, activeId) {
  // A background DRAFT with content also needs a decision even when captured
  // clean — drafts prompt on close regardless of dirty (SAVEFLOW option B).
  return tabs.filter((t) => t.id !== activeId &&
    (isCapturedDirty(t) || (isDraftTab(t) && t.text != null && t.text.trim().length > 0)));
}
