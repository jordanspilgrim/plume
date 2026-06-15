# Plume

A fast, single-surface Markdown editor. The syntax marks **reveal only on the line you're editing** — everywhere else, this reads like a finished document.

## Why it exists

Most editors force a choice: raw source *or* a rendered preview. Plume collapses that into **one surface**. Click into this line and the `**` and `*` appear; click away and they vanish.

### Things it handles

- Headings, **bold**, *italic*, ~~strikethrough~~, and `inline code`
- Lists, nested and flat
- [Links](https://www.markdownguide.org) — Cmd-click to follow
- Task lists:
  - [x] Single-surface live preview
  - [x] Open & save real files
  - [ ] Math and Mermaid (phase 2)

> It's just plain text on disk. `grep` it, `git diff` it, pipe it through `sed`.

---

```js
// Code blocks keep their monospace + background
function greet(name) {
  return `Hello, ${name}`;
}
```

The file you save is **exactly** what you typed — no proprietary wrapper, no lock-in.
