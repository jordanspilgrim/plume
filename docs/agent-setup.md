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

## 5. MCP — let the agent read and steer through Plume

Plume ships a first-party MCP server (`plume-mcp`, installed alongside `plume`).
Connect it once:

```bash
claude mcp add plume -- plume-mcp        # Claude Code
# Codex / Claude Desktop: add { "command": "plume-mcp" } to your MCP config
```

Tools the agent gets:

| Tool | What it does |
|---|---|
| `open_in_plume` | Open a file (optionally at a line) and bring it to the front |
| `get_active_document` | The path + full text of what you're viewing (incl. unsaved edits) |
| `get_selection` | The text you currently have selected, with its line range |
| `list_open_files` | Every file open in Plume |
| `get_annotations` | Your margin notes — the steer instructions you left |
| `write_document` | Write a revision to disk (Plume live-reloads) |

### The steer loop

1. The agent writes a draft and runs `plume draft.md`.
2. You read it. Select a passage, press **⌘J**, and type what you want changed —
   e.g. *"make it teal, not blue."* The note shows in the **Notes** panel.
3. The agent calls `get_annotations`, reads your instruction, revises with
   `write_document`. Plume live-reloads to the new version.

You steer in prose, on the exact text; the agent picks it up and applies it.

## 6. Publish to Google Docs (one-time setup)

Turn the Markdown you're viewing into a shareable Google Doc:
**File ▸ Publish to Google Docs…** (or the command palette). Disk stays the
source of truth — this is a one-way publish, not a sync.

Google requires *your own* OAuth client (Plume can't ship one), so the first
time you'll do a 5-minute setup:

1. At [console.cloud.google.com](https://console.cloud.google.com): create/pick a
   project and **enable the Google Docs API**.
2. **APIs & Services ▸ Credentials ▸ Create credentials ▸ OAuth client ID**,
   application type **Desktop app**.
3. Save the client to `~/.plume/google.json`:
   ```json
   { "client_id": "…apps.googleusercontent.com", "client_secret": "…" }
   ```
   (Or set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in the environment.)
4. Publish again — a browser tab asks you to authorize once; the token is cached
   in `~/.plume/google-token.json`. Future publishes are one click.

The Markdown is converted to native Google Docs formatting — headings, bold/
italic, inline code, links, and bullet/numbered lists.
