// Steer-loop annotations: a highlight over a quoted range that carries a note
// the agent can read back via MCP. Decorations live in a StateField so they map
// through edits; ranges are (re)anchored to the quoted text on load/add so they
// survive reload and agent rewrites.

import { StateField, StateEffect } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";

// payload: [{ id, from, to, resolved }]
export const setAnnotRanges = StateEffect.define();

export const annotField = StateField.define({
  create() { return Decoration.none; },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setAnnotRanges)) {
        const ranges = e.value
          .filter((r) => r.from < r.to)
          .sort((a, b) => a.from - b.from)
          .map((r) =>
            Decoration.mark({
              class: "tok-annot v-" + (r.verdict || "revise") + (r.resolved ? " resolved" : ""),
              attributes: { "data-annot": String(r.id) },
            }).range(r.from, r.to)
          );
        deco = Decoration.set(ranges, true);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Find the range of `quote` in the doc, choosing the occurrence nearest hintLine. */
export function locateQuote(state, quote, hintLine) {
  if (!quote) return null;
  const text = state.doc.toString();
  let idx = text.indexOf(quote);
  if (idx < 0) return null;
  if (hintLine) {
    let best = idx, bestDist = Infinity, i = idx;
    while (i >= 0) {
      const ln = state.doc.lineAt(i).number;
      const d = Math.abs(ln - hintLine);
      if (d < bestDist) { bestDist = d; best = i; }
      i = text.indexOf(quote, i + 1);
    }
    idx = best;
  }
  return { from: idx, to: idx + quote.length };
}
