import MarkdownIt from "markdown-it";
import { stripFrontMatter } from "./frontmatter.js";

// html:false — a document is untrusted; raw <script>/<img onerror> in the source must
// not pass through verbatim into exported HTML or the rich-text clipboard payload
// (which then executes when opened in a browser / pasted into a permissive target).
const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });

export function mdToHtml(src) {
  // Drop a leading front-matter block: those are Plume settings, not content,
  // and MarkdownIt would otherwise render the fences as an <hr> + setext <h2>
  // in copied and exported HTML.
  return md.render(stripFrontMatter(src || ""));
}

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

const EXPORT_CSS = `
*{box-sizing:border-box}
body{margin:0;background:#fff;color:#1d1d1f;
  font:16px/1.7 -apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;
  -webkit-font-smoothing:antialiased}
.md{max-width:44rem;margin:0 auto;padding:56px 36px}
.md h1{font-size:2em;font-weight:700;line-height:1.25;margin:0 0 .6em}
.md h2{font-size:1.5em;font-weight:700;margin:1.6em 0 .5em}
.md h3{font-size:1.25em;font-weight:650;margin:1.4em 0 .4em}
.md h4,.md h5,.md h6{font-weight:650;margin:1.2em 0 .3em}
.md p{margin:0 0 1em}
.md a{color:#2f6df6;text-decoration:none}
.md a:hover{text-decoration:underline}
.md code{font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:.88em;
  background:#f0f0ee;color:#9a5518;padding:.1em .34em;border-radius:5px}
.md pre{background:#f6f6f4;border:1px solid #ececea;border-radius:8px;
  padding:14px 16px;overflow:auto;line-height:1.5}
.md pre code{background:none;color:#1d1d1f;padding:0}
.md blockquote{border-left:3px solid #d8d8d2;color:#6e6e76;
  margin:0 0 1em;padding:.2em 0 .2em 16px;font-style:italic}
.md ul,.md ol{padding-left:1.6em;margin:0 0 1em}
.md li{margin:.2em 0}
.md table{border-collapse:collapse;margin:0 0 1em;font-size:.95em}
.md th,.md td{border:1px solid #e0e0dc;padding:6px 12px;text-align:left}
.md th{background:#f6f6f4;font-weight:650}
.md img{max-width:100%;border-radius:8px}
.md hr{border:none;border-top:1px solid #e6e6e2;margin:2em 0}
.md del{color:#9aa1ad}
@media print{.md{max-width:none;padding:0}}
`;

export function fullHtmlDocument(bodyHtml, title) {
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>${esc(title || "Document")}</title>` +
    `<style>${EXPORT_CSS}</style></head>` +
    `<body><article class="md">${bodyHtml}</article></body></html>`;
}
