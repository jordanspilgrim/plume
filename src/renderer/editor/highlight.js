import { LanguageDescription, LanguageSupport, StreamLanguage, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

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

const desc = (name, alias, load) => LanguageDescription.of({ name, alias, load });

export const codeLanguages = [
  desc("javascript", ["js", "jsx", "mjs", "cjs", "node"], () =>
    Promise.resolve(javascript({ jsx: true }))),
  desc("typescript", ["ts", "tsx"], () =>
    Promise.resolve(javascript({ jsx: true, typescript: true }))),
  desc("python", ["py"], () => Promise.resolve(python())),
  desc("json", ["json5"], () => Promise.resolve(json())),
  desc("css", [], () => Promise.resolve(css())),
  desc("html", ["htm", "xhtml"], () => Promise.resolve(html())),
  desc("sql", ["postgres", "postgresql", "mysql"], () => Promise.resolve(sql())),
  desc("yaml", ["yml"], () => Promise.resolve(yaml())),
  desc("rust", ["rs"], () => Promise.resolve(rust())),
  desc("go", ["golang"], () => Promise.resolve(go())),
  desc("cpp", ["c", "c++", "h", "hpp", "cc"], () => Promise.resolve(cpp())),
  desc("java", [], () => Promise.resolve(java())),
  desc("php", [], () => Promise.resolve(php())),
  desc("xml", ["svg", "rss"], () => Promise.resolve(xml())),
  desc("shell", ["bash", "sh", "zsh", "console", "shellscript"], () =>
    Promise.resolve(new LanguageSupport(StreamLanguage.define(shell)))),
];

// Colors come from CSS variables (see styles.css) so they follow the theme.
export const codeHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.moduleKeyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword], color: "var(--syn-keyword)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.atom, t.null], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: "var(--syn-function)" },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: "var(--syn-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syn-property)" },
  { tag: [t.variableName, t.labelName], color: "var(--syn-variable)" },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.brace], color: "var(--syn-punct)" },
  { tag: [t.escape, t.special(t.brace)], color: "var(--syn-number)" },
  { tag: [t.invalid], color: "var(--syn-invalid)" },
  { tag: [t.heading], color: "var(--text)" },
]);
