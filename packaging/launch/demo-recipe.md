# Hero demo GIF — recording recipe

The single most important launch asset (research: "the demo IS the marketing").
A 12–18s split-screen loop: **agent writes on the left → Plume renders + you steer
on the right.** Pair it with `title-card.png` and the terminal banner screenshot.

## Setup

- Two windows, side by side, each ~720px wide:
  - **Left:** a terminal running Claude Code (or Codex/Gemini) — dark theme, big font.
  - **Right:** Plume, opened on the file the agent is writing (`plume plan.md`).
- macOS dark mode both sides; hide the dock; clean menu bar.
- Recorder: **Kap** or **CleanShot X** (GIF export, ~12fps, capture the two-window region).

## The 15-second script

1. **(0–4s) Live reload.** In the terminal, ask the agent to write a short plan to
   `plan.md`. As it writes, Plume on the right renders it live — headings, a table,
   a code block appear in real time. *This is the hook.*
2. **(4–9s) Typed steering.** In Plume, select a sentence, press **⌘J**, pick **✎ revise**,
   type "tighten this — too vague," save. The colored highlight + Notes chip appear.
3. **(9–13s) Agent revises + you review.** Back in the terminal: "read my Plume notes
   and revise." The agent calls `get_annotations` → `write_document`. Plume pops the
   **accept/reject diff**; click **Accept** on the good hunk.
4. **(13–15s) Land on the title screen** or the rendered doc. Loop.

## Export

- GIF, ≤ 8 MB (HN/PH/X friendly), 12fps, loop. Also export an MP4 (X prefers video).
- Caption overlay (optional, large): "the agent writes — you steer."

## Quick assets already in this folder

- `title-card.svg` / `title-card.png` — 8-bit wordmark card (also a 1200×630 OG image).
- Terminal banner — run `plume --help` (or `plume -v`) in a nice terminal and
  screenshot the gradient ASCII wordmark.
