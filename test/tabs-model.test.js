// Unit tests for the pure document-tab model (#10 in-window tabs).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTab, findTab, addTab, closeTab, cycleTabId,
  tabDisplayName, isCapturedDirty, isBlankTab,
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
