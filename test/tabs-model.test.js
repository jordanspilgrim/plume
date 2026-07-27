// Unit tests for the pure document-tab model (#10 in-window tabs).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTab, findTab, addTab, closeTab, cycleTabId,
  tabDisplayName, isCapturedDirty, isBlankTab, closeDecision, dirtyBackgroundTabs, isDraftTab,
} from "../src/renderer/tabs-model.js";

test("createTab: unique ids, defaults, partial override", () => {
  const a = createTab();
  const b = createTab({ path: "/docs/readme.md" });
  assert.notEqual(a.id, b.id);
  assert.equal(a.path, null);
  assert.equal(a.text, null);
  assert.equal(b.path, "/docs/readme.md");
});

test("addTab appends by default and inserts after a given id", () => {
  const a = createTab(), b = createTab(), c = createTab();
  let tabs = addTab([], a);
  tabs = addTab(tabs, b);
  assert.deepEqual(tabs.map((t) => t.id), [a.id, b.id]);
  tabs = addTab(tabs, c, a.id);
  assert.deepEqual(tabs.map((t) => t.id), [a.id, c.id, b.id]);
  // Unknown afterId falls back to append.
  const d = createTab();
  tabs = addTab(tabs, d, "nope");
  assert.equal(tabs.at(-1).id, d.id);
});

test("findTab returns the tab or null", () => {
  const a = createTab();
  assert.equal(findTab([a], a.id), a);
  assert.equal(findTab([a], "missing"), null);
});

test("closeTab picks the right neighbor, then last, then null", () => {
  const a = createTab(), b = createTab(), c = createTab();
  const tabs = [a, b, c];
  // Closing a middle tab activates the one that slid into its slot (right neighbor).
  let r = closeTab(tabs, b.id);
  assert.deepEqual(r.tabs.map((t) => t.id), [a.id, c.id]);
  assert.equal(r.nextActiveId, c.id);
  // Closing the last tab activates the new last.
  r = closeTab(tabs, c.id);
  assert.equal(r.nextActiveId, b.id);
  // Closing the only tab yields an empty list.
  r = closeTab([a], a.id);
  assert.deepEqual(r.tabs, []);
  assert.equal(r.nextActiveId, null);
  // Unknown id is a no-op.
  r = closeTab(tabs, "missing");
  assert.equal(r.tabs, tabs);
  assert.equal(r.nextActiveId, null);
});

test("cycleTabId wraps in both directions", () => {
  const a = createTab(), b = createTab(), c = createTab();
  const tabs = [a, b, c];
  assert.equal(cycleTabId(tabs, a.id, +1), b.id);
  assert.equal(cycleTabId(tabs, c.id, +1), a.id); // wrap forward
  assert.equal(cycleTabId(tabs, a.id, -1), c.id); // wrap backward
  assert.equal(cycleTabId([a], a.id, +1), a.id);  // single tab: stay
  assert.equal(cycleTabId(tabs, "missing", +1), a.id); // unknown: first
});

test("tabDisplayName: basename > pendingName > Untitled", () => {
  assert.equal(tabDisplayName(createTab({ path: "/a/b/notes.md" })), "notes.md");
  assert.equal(tabDisplayName(createTab({ pendingName: "draft" })), "draft");
  assert.equal(tabDisplayName(createTab()), "Untitled");
});

test("isCapturedDirty compares captured buffer to captured savedText", () => {
  assert.equal(isCapturedDirty(createTab()), false); // active/live tab: nulls
  assert.equal(isCapturedDirty(createTab({ text: "x", savedText: "x" })), false);
  assert.equal(isCapturedDirty(createTab({ text: "x", savedText: "y" })), true);
});

test("isBlankTab: no path and no captured content", () => {
  assert.equal(isBlankTab(createTab()), true);
  assert.equal(isBlankTab(createTab({ text: "" })), true);
  assert.equal(isBlankTab(createTab({ text: "hi" })), false);
  assert.equal(isBlankTab(createTab({ path: "/x.md" })), false);
});

// Owner UAT decision (2026-07-27): closing a dirty doc PROMPTS — never a
// silent write. Matrix: {clean, dirty-untitled, dirty-saved} × {save, discard,
// cancel/escape}.
test("closeDecision: clean docs close immediately, no prompt", () => {
  assert.equal(closeDecision({ dirty: false, hasPath: false }), "close");
  assert.equal(closeDecision({ dirty: false, hasPath: true }), "close");
  // Even with a stray choice supplied, clean stays a plain close.
  assert.equal(closeDecision({ dirty: false, hasPath: true }, "save"), "close");
});

test("closeDecision: dirty docs prompt before anything happens", () => {
  assert.equal(closeDecision({ dirty: true, hasPath: false }), "prompt");
  assert.equal(closeDecision({ dirty: true, hasPath: true }), "prompt");
});

test("closeDecision: Save routes by path — Save As for untitled, in-place for saved", () => {
  assert.equal(closeDecision({ dirty: true, hasPath: false }, "save"), "saveas-then-close");
  assert.equal(closeDecision({ dirty: true, hasPath: true }, "save"), "save-then-close");
});

test("closeDecision: Don't Save closes without writing", () => {
  assert.equal(closeDecision({ dirty: true, hasPath: false }, "discard"), "close");
  assert.equal(closeDecision({ dirty: true, hasPath: true }, "discard"), "close");
});

test("closeDecision: Cancel / Escape / unknown keep the doc open", () => {
  assert.equal(closeDecision({ dirty: true, hasPath: false }, "cancel"), "stay");
  assert.equal(closeDecision({ dirty: true, hasPath: true }, "cancel"), "stay");
  assert.equal(closeDecision({ dirty: true, hasPath: true }, "bogus"), "stay");
});

// Renderer-authoritative close (Cluster A): every captured-dirty background
// tab gets its own decision on window close — none may be dropped silently.
test("dirtyBackgroundTabs: finds dirty drafts (untitled AND saved) behind the active tab", () => {
  const active = createTab({ path: "/notes/a.md" });
  const draft = createTab({ text: "unsaved draft", savedText: "" }); // dirty untitled
  const dirtySaved = createTab({ path: "/notes/c.md", text: "edited", savedText: "orig" });
  const clean = createTab({ path: "/notes/b.md", text: "x", savedText: "x" });
  const tabs = [active, draft, dirtySaved, clean];
  assert.deepEqual(dirtyBackgroundTabs(tabs, active.id).map((t) => t.id), [draft.id, dirtySaved.id]);
  // The active tab is never in the background list, even if captured-dirty.
  const dirtyActive = createTab({ text: "y", savedText: "z" });
  assert.deepEqual(dirtyBackgroundTabs([dirtyActive], dirtyActive.id), []);
});

// Cluster A pillar 2: unbound tabs (file moved/deleted) keep their identity in
// the model; only an explicit re-load clears the flag.
test("createTab: unbound defaults false and is preserved via partials", () => {
  assert.equal(createTab().unbound, false);
  assert.equal(createTab({ unbound: true, path: "/gone.md" }).unbound, true);
});

// P2-C rule pin: only a DIRTY captured buffer may be restored over disk
// content; a clean tab takes whatever is on disk (possibly newer).
test("isCapturedDirty is the restore-eligibility rule (clean tabs never restore)", () => {
  const clean = createTab({ path: "/a.md", text: "same", savedText: "same" });
  const dirty = createTab({ path: "/a.md", text: "edited", savedText: "orig" });
  assert.equal(isCapturedDirty(clean), false); // → present disk content
  assert.equal(isCapturedDirty(dirty), true);  // → restore the buffer
});

// SAVEFLOW (owner option B): drafts prompt on close regardless of dirty.
test("closeDecision: non-empty draft prompts even when clean; empty draft closes", () => {
  assert.equal(closeDecision({ dirty: false, hasPath: true, isDraft: true }), "prompt");
  assert.equal(closeDecision({ dirty: true, hasPath: true, isDraft: true }), "prompt");
  assert.equal(closeDecision({ dirty: false, hasPath: true, isDraft: true, empty: true }), "close");
});

test("closeDecision: draft Save graduates (Save As); Don't Save deletes the draft", () => {
  assert.equal(closeDecision({ dirty: false, hasPath: true, isDraft: true }, "save"), "saveas-then-close");
  assert.equal(closeDecision({ dirty: false, hasPath: true, isDraft: true }, "discard"), "delete-draft-then-close");
  assert.equal(closeDecision({ dirty: false, hasPath: true, isDraft: true }, "cancel"), "stay");
  // Non-drafts are unchanged by the new axis.
  assert.equal(closeDecision({ dirty: true, hasPath: true }, "save"), "save-then-close");
  assert.equal(closeDecision({ dirty: true, hasPath: true }, "discard"), "close");
});

test("isDraftTab: authoritative prefix vs the native-published dir, never a shape heuristic", () => {
  const DIR = "/Users/x/Documents/Plume/Autosave";
  assert.equal(isDraftTab(createTab({ path: DIR + "/note.md" }), DIR), true);
  assert.equal(isDraftTab(createTab({ path: DIR + "/note.md" }), DIR + "/"), true); // trailing-slash tolerant
  assert.equal(isDraftTab(createTab({ path: "/Users/x/Documents/Plume/real.md" }), DIR), false);
  // be-dev F1: a USER file whose path merely LOOKS like a drafts path is NOT a draft.
  assert.equal(isDraftTab(createTab({ path: "/Users/x/work/Plume/Autosave/notes.md" }), DIR), false);
  // No draftsDir known (native absent) → nothing is a draft.
  assert.equal(isDraftTab(createTab({ path: DIR + "/note.md" }), null), false);
  assert.equal(isDraftTab(createTab(), DIR), false);
  // An unbound draft (file vanished) falls back to normal dirty semantics.
  assert.equal(isDraftTab(createTab({ path: DIR + "/note.md", unbound: true }), DIR), false);
});

test("dirtyBackgroundTabs: clean background DRAFT with content still needs a decision", () => {
  const DIR = "/Users/x/Documents/Plume/Autosave";
  const active = createTab({ path: "/notes/a.md" });
  const cleanDraft = createTab({ path: DIR + "/note.md", text: "draft body", savedText: "draft body" });
  const emptyDraft = createTab({ path: DIR + "/empty.md", text: "  ", savedText: "  " });
  const cleanDoc = createTab({ path: "/notes/b.md", text: "x", savedText: "x" });
  assert.deepEqual(dirtyBackgroundTabs([active, cleanDraft, emptyDraft, cleanDoc], active.id, DIR).map((x) => x.id), [cleanDraft.id]);
  // Without a draftsDir, only genuinely dirty tabs qualify (no draft semantics).
  assert.deepEqual(dirtyBackgroundTabs([active, cleanDraft, cleanDoc], active.id), []);
});
