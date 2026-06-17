# Plume in your agent stack

Plume is the **human pane** for agentic coding: the terminal is where your agent
(Claude Code, Gemini CLI, Codex) works; Plume is where you read, steer, and ship
what it writes — plans, specs, reports, diffs, logs, JSONL transcripts.

## 1. Install the `plume` command

In Plume: **File ▸ Install 'plume' Shell Command…** (writes `plume` to
`/usr/local/bin`, the VS Code `code` pattern). Then from any shell:

```bash
plume plan.md              # open or focus a file
plume report.md --line 42  # open and jump to a line
plume .                    # open the current folder in the sidebar
plume --new draft.md       # force a new window
plume                      # bring Plume to the front
```

Plume auto-reloads the open document the instant the file changes on disk, so as
your agent writes, the rendered view updates live — no refresh.

## 2. Let the agent open things for you

Add this to your repo's `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` so the agent
surfaces its own output:

```markdown
## Surfacing work to the human
When you finish writing a plan, spec, report, or any Markdown the user should
read, run `plume <file>` to open it in the Plume editor (the user's reading pane).
For a specific location, use `plume <file> --line <n>`.
```

## 3. Optional: a Claude Code hook

Auto-open Markdown the agent writes. Add to `.claude/settings.json` (this opens
on every Markdown `Write` — remove if too eager):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "f=$(jq -r '.tool_input.file_path // empty'); case \"$f\" in *.md|*.markdown) plume \"$f\" >/dev/null 2>&1 & ;; esac"
          }
        ]
      }
    ]
  }
}
```

## 4. Deep links

Anything that can open a URL can drive Plume:

```
plume://open?path=/abs/path/to/file.md&line=12
```

---

The same control channel (`~/.plume/plume.sock`, newline-delimited JSON) powers a
first-party **MCP server** (next), so an agent can open files, read your current
selection, and pick up margin notes you leave — closing the steer loop.
