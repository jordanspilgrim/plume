# Plume — launch copy

The one-liner everything hangs off:
**Plume is the human pane for agentic coding. The terminal is where the agent writes; Plume is where you read, steer, and ship what it wrote.**

The differentiated framing (use when the audience is technical):
**GitHub-PR-review, but for the prose your agents produce — in the human→agent direction.**

---

## Show HN

**Title:** `Show HN: Plume – a markdown editor that's the human pane for AI coding agents`

**Body:**

> Your agent (Claude Code, Codex, Gemini CLI) writes a flood of human-readable
> stuff — plans, specs, reports, diffs, JSONL transcripts — and there's no good
> place to *read and steer* it. You `cat` it, or open VS Code (heavy, code-shaped),
> or squint at a pager.
>
> Plume is a single-surface markdown editor (Typora-style live preview) wired into
> the agent loop:
>
> - **A first-party MCP server.** The agent opens a draft in Plume; you read it.
> - **Typed steering.** Select a passage, hit ⌘J, and give it a verdict —
>   ✓ approve / ✕ reject / ✎ revise / ❓ question / 📌 pin. The agent reads
>   structured directives via `get_annotations`, not a paragraph to interpret.
> - **You review the revision as a diff.** When it writes back, Plume shows the
>   change as accept/reject hunks linked to each directive. It's a PR review, for
>   prose. The model can't generate that human judgment for itself — that's the point.
> - Browse your **Claude + Codex + Gemini** sessions in one place; one-way publish
>   to Google Docs; rich-paste fidelity from Notes/Word/Docs.
>
> It's Tauri (Rust + the OS webview), so ~10MB, not an Electron brick. macOS today;
> Windows/Linux building. `brew install --cask plume`, or grab the signed DMG.
>
> Built it because I live in `.md` files all day next to coding agents and wanted
> the reading-and-steering half of the loop to feel as good as the terminal half.
> Happy to talk about the MCP steer-loop design.

*(Post 8–10am PT on a weekday. Lead the comments with the split-screen GIF.)*

---

## Product Hunt

**Name:** Plume
**Tagline:** The human pane for agentic coding
**Description:**

> Your AI coding agent writes plans, specs, and reports all day. Plume is where you
> *read and steer* them. A fast (~10MB) single-surface markdown editor with a
> first-party MCP server: drop typed verdicts on any passage (approve / reject /
> revise / question / pin), and the agent revises — then you review its revision as
> an accept/reject diff. GitHub-PR-review, but for prose. Works with Claude Code,
> Codex, and Gemini CLI.

**Maker's first comment:**

> Hi PH 👋 I built Plume because the terminal is a great pane for the *agent*, but a
> terrible one for the *human* reading the agent's output. The piece I'm proudest of
> is the steer loop: you don't chat corrections, you mark the exact passage with a
> verdict, and you review the agent's revision hunk-by-hunk. Would love feedback on
> whether directed steering beats just editing the file together.

---

## X / launch thread (skeleton)

1. The terminal is the agent's pane. There's no good human pane for the plans,
   specs, and reports it writes. So I built one. 🪶 [split-screen GIF]
2. Select a passage → verdict (✓✕✎❓📌) → the agent reads it as a directive and
   revises → you accept/reject its changes hunk by hunk. PR review, for prose.
3. MCP-native, so it works with Claude Code, Codex, and Gemini. ~10MB Tauri, not
   Electron. `brew install --cask plume`.

---

## The aesthetic IS the strategy

This audience selects tools on vibe (the TUI renaissance, charm/gum, Claude Code's
own banner). Lean into the 8-bit wordmark:
- The **terminal banner** (`plume --help` / `plume -v`) prints the gradient ASCII
  wordmark — screenshot it for the launch.
- The in-app **title screen** (open Plume with no file) is the most screenshot-able
  surface — see `packaging/launch/title-screen.png`.
Pair those two images with the demo GIF for Show HN + PH + X.
