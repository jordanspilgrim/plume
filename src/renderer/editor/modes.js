import { lineNumbers, highlightActiveLine, highlightActiveLineGutter, keymap } from "@codemirror/view";
import {
  foldGutter, codeFolding, foldKeymap, StreamLanguage, bracketMatching, indentOnInput,
} from "@codemirror/language";

import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { sql } from "@codemirror/lang-sql";
import { yaml } from "@codemirror/lang-yaml";
import { rust } from "@codemirror/lang-rust";
import { go } from "@codemirror/lang-go";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { php } from "@codemirror/lang-php";
import { xml } from "@codemirror/lang-xml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { properties } from "@codemirror/legacy-modes/mode/properties";

export function baseName(p) { return (p || "").split("/").pop().toLowerCase(); }
export function extOf(p) {
  const n = baseName(p);
  return n.includes(".") ? n.split(".").pop() : "";
}

/** Pick a high-level rendering mode from the file path. */
export function modeForPath(p) {
  const name = baseName(p);
  const ext = extOf(p);
  if (/\.(md|markdown|mdown|mkd|mdx)$/.test(name) || name === "readme") return "markdown";
  if (ext === "jsonl" || ext === "ndjson") return "jsonl";
  if (ext === "diff" || ext === "patch") return "diff";
  if (ext === "log") return "log";
  if (ext === "csv" || ext === "tsv") return "csv";
  if (ext === "mmd") return "mermaid";
  return "code";
}

const stream = (m) => StreamLanguage.define(m);

/** A CodeMirror language extension for a code/config file, or null for plain text. */
export function languageForExt(ext, name = "") {
  switch (ext) {
    case "js": case "jsx": case "mjs": case "cjs": return javascript({ jsx: true });
    case "ts": case "tsx": return javascript({ jsx: true, typescript: true });
    case "json": case "jsonc": case "json5": return json();
    case "py": return python();
    case "css": case "scss": case "less": return css();
    case "html": case "htm": case "xhtml": case "vue": case "svelte": return html();
    case "sql": return sql();
    case "yaml": case "yml": return yaml();
    case "toml": return stream(toml);
    case "env": case "ini": case "properties": case "conf": case "cfg": return stream(properties);
    case "rs": return rust();
    case "go": return go();
    case "c": case "h": case "cpp": case "cc": case "hpp": case "cxx": return cpp();
    case "java": return java();
    case "php": return php();
    case "xml": case "svg": case "rss": case "plist": return xml();
    case "sh": case "bash": case "zsh": case "fish": return stream(shell);
    default:
      // dotfiles like ".env.local" / "Dockerfile"
      if (name === "dockerfile") return stream(properties);
      if (name.startsWith(".env")) return stream(properties);
      return null;
  }
}

/** Editor features for code/config modes (gutter, folding, bracket matching). */
export const codeFeatures = [
  lineNumbers(),
  foldGutter(),
  codeFolding(),
  bracketMatching(),
  indentOnInput(),
  highlightActiveLine(),
  highlightActiveLineGutter(),
  keymap.of(foldKeymap),
];
