# Plume

A fast, single-surface Markdown editor for macOS — **renders like a document, saves like a text file, never makes you choose between reading and writing.**

The Markdown syntax marks (`**`, `#`, `` ` ``, `[]()`) reveal only on the line your cursor is on. Everywhere else, the document reads finished — bold is bold, headings are sized, links show their text, checkboxes are checkboxes. What's on disk is exactly what you typed: plain UTF-8 Markdown, no proprietary wrapper, no lock-in.

Built on Electron + CodeMirror 6.

## Features (v1)

- **Single-surface live preview** — Obsidian/Typora-style "marks reveal on the active line"
- Headings, **bold**, *italic*, ~~strike~~, `inline code`, blockquotes, lists, code blocks
- **Task lists** with clickable checkboxes
- **Horizontal rules** rendered as actual rules
- **Links** show their text; ⌘-click to follow (external URLs open in your browser, relative `.md` links open in a new Plume window)
- **Outline** panel (⌘⇧O) with click-to-jump
- **Find / replace** (⌘F)
- **Formatting shortcuts** — ⌘B/⌘I/⌘E/⌘K, ⌘1/2/3 for headings
- **Light / dark / system** themes
- **Font picker** — Inter (default), System (SF Pro), New York, Charter, Iowan, JetBrains Mono
- **Hidden Markdown marks** — `#`, `*`, etc. stay out of sight even on the line you're editing (bullets render as `•`); toggle raw syntax back with View ▸ Reveal Marks (⌘⇧M)
- **Formatting toolbar** — one-click headings, bold/italic/strike/code/link, lists, quote, code block, table, divider, image alt text, and copy-for-Google-Docs
- Opens via Finder "Open With", registers as a default `.md` handler
- Reload/crash-resilient (re-opens the document on renderer reload)

### Phase 2

- **Per-language syntax highlighting** inside code fences (JS/TS, Python, Bash, JSON, CSS, HTML, SQL, YAML, Rust, Go, C/C++, Java, PHP, XML)
- **Live-rendered tables** with column alignment and inline markdown in cells
- **KaTeX math** — inline `$…$` and display `$$…$$`, with a conservative heuristic that leaves currency (`$5`) and shell vars (`$HOME`) as literal text
- **Mermaid diagrams** (theme-aware) rendered from ` ```mermaid ` fences
- **Inline image preview** with relative-path resolution
- **Autosave** to disk on idle, plus **crash recovery** with a restore banner

### Agentic-dev companion

Plume detects the file type and renders it appropriately — ideal for living next to an agent like Claude Code:

- **Live auto-reload** — the open document refreshes the instant the file changes on disk (e.g. when an agent writes it), preserving your scroll. Unsaved edits trigger a non-destructive "changed on disk" prompt instead of clobbering.
- **Code & config editing** — JSON/JSONC, YAML, TOML, `.env`/INI, JS/TS, Python, shell, and more open with line numbers, code folding, bracket matching, and syntax highlighting. `Format Document` prettifies JSON.
- **JSONL / NDJSON viewer** — transcripts, traces, and eval datasets render as collapsible, role-tagged records (great for Claude Code session files).
- **Diff / patch viewer** — `.diff`/`.patch` show file/hunk headers and red/green add/remove lines.
- **Log viewer** — `.log` files highlight ERROR/WARN/INFO levels and timestamps, interpret ANSI color, and **tail-follow** to the newest line as the file grows.
- **CSV / TSV** render as tables; standalone **`.mmd`** render as Mermaid diagrams. Toggle source/rendered with ⌘/.

### Daily driver, sharing & writing

- **Folder sidebar** (⌘⇧E) — browse the open file's folder and switch files in place.
- **Command palette** (⌘P) — fuzzy file quick-open + every command; type `>` to filter commands.
- **Search in folder** (⌘⇧F) — grep across the folder, click a hit to jump to the file and line.
- **Share-out** — *Copy as Rich Text* (⌘⇧C, paste formatted into Mail/Slack/Docs) and *Copy as HTML*; **Export** to PDF, HTML, and Word (`.docx`).
- **Images** — paste, drop, or pick an image (toolbar) and it's saved beside the file with a relative link; the toolbar image button also edits an existing image's alt text.
- **Link previews** — a line that's just a link or URL renders as a card (title/description/site, fetched from the page); if the URL is an image, it displays inline.
- **Writer tools** — live word count + reading time, `==highlight==`, `> [!NOTE]` callouts, and **Focus mode** (⌘⇧L) that dims everything but the current paragraph.

### In your agent stack

Plume is the **human pane** for agentic coding — the terminal is where your agent
writes; Plume is where you read, steer, and ship it.

- **`plume` CLI** — `plume plan.md`, `plume report.md --line 42`, `plume .` (folder), `plume --new`. Install via **File ▸ Install 'plume' Shell Command…**. Talks to a running Plume over a local socket (`~/.plume/plume.sock`); launches it if needed.
- **Auto-reload** means the rendered view updates live as the agent writes.
- **Deep links** — `plume://open?path=/abs/file.md&line=12`.
- **Drop-in agent config** + an optional Claude Code hook so the agent opens its own output — see [docs/agent-setup.md](docs/agent-setup.md).

## Develop

```bash
npm install
npm start          # build renderer + launch
npm run watch:renderer   # rebuild renderer on change (run electron . separately)
```

## Build the app

```bash
npm run dist       # → release/mac-arm64/Plume.app
```

Then drag `Plume.app` to `/Applications`, and set it as the default for `.md`:
right-click any `.md` → Get Info → Open with → Plume → Change All.

## Roadmap

- Live table cell editing (edit a rendered cell in place)
- Reshell in Tauri for a ~10 MB instant-launch native binary
- Per-document settings (front-matter driven)

## License

MIT
