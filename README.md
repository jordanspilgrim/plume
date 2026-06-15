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
- Opens via Finder "Open With", registers as a default `.md` handler
- Reload/crash-resilient (re-opens the document on renderer reload)

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

## Roadmap (phase 2)

- Inline tables with live column editing
- KaTeX math, Mermaid diagrams
- Per-language syntax highlighting inside code fences
- Inline image rendering
- Reshell in Tauri for a ~10 MB instant-launch native binary

## License

MIT
