import MarkdownIt from "markdown-it";

// Dedicated renderer for transcript prose. html:false escapes any raw HTML in
// message text, so injecting it via innerHTML can't smuggle markup.
const convMd = new MarkdownIt({ html: false, linkify: true, breaks: true, typographer: false });

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function highlightJson(json) {
  return escapeHtml(json).replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(\.\d+)?([eE][+-]?\d+)?)/g,
    (match) => {
      let cls = "j-num";
      if (/^"/.test(match)) cls = /:\s*$/.test(match) ? "j-key" : "j-str";
      else if (/true|false/.test(match)) cls = "j-bool";
      else if (/null/.test(match)) cls = "j-null";
      return `<span class="${cls}">${match}</span>`;
    }
  );
}

/** Best-effort one-line summary of a JSON record for the collapsed header. */
function recordSummary(obj) {
  if (obj === null || typeof obj !== "object") return { role: null, preview: String(obj) };
  const role = obj.role || obj.type || obj.level || obj.event || obj.name || null;
  let body = obj.content ?? obj.message ?? obj.text ?? obj.summary ?? obj.prompt;
  let preview;
  if (typeof body === "string") preview = body;
  else if (Array.isArray(body)) preview = body.map((b) => (typeof b === "string" ? b : b?.text || b?.type || JSON.stringify(b))).join(" ");
  else if (body && typeof body === "object") preview = JSON.stringify(body);
  else preview = Object.keys(obj).slice(0, 8).join(", ");
  return { role, preview: String(preview).replace(/\s+/g, " ").trim().slice(0, 200) };
}

export function renderJsonl(container, text) {
  container.innerHTML = "";
  let n = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    n++;
    const card = document.createElement("div");
    card.className = "jsonl-record";
    const head = document.createElement("div");
    head.className = "jsonl-head";
    const idx = document.createElement("span");
    idx.className = "jsonl-idx";
    idx.textContent = n;
    head.appendChild(idx);

    let obj, ok = true;
    try { obj = JSON.parse(line); } catch { ok = false; }

    if (ok) {
      const s = recordSummary(obj);
      if (s.role) {
        const r = document.createElement("span");
        r.className = "jsonl-role";
        r.textContent = s.role;
        head.appendChild(r);
      }
      const pv = document.createElement("span");
      pv.className = "jsonl-preview";
      pv.textContent = s.preview;
      head.appendChild(pv);
      const body = document.createElement("pre");
      body.className = "jsonl-body hidden";
      body.innerHTML = highlightJson(JSON.stringify(obj, null, 2));
      head.addEventListener("click", () => {
        body.classList.toggle("hidden");
        card.classList.toggle("open");
      });
      card.append(head, body);
    } else {
      card.classList.add("bad");
      const pv = document.createElement("span");
      pv.className = "jsonl-preview";
      pv.textContent = line.slice(0, 300);
      head.appendChild(pv);
      card.appendChild(head);
    }
    container.appendChild(card);
  }
  if (n === 0) {
    const e = document.createElement("div");
    e.className = "render-empty";
    e.textContent = "No records";
    container.appendChild(e);
  }
}

/** Heuristic: does this .jsonl look like a Claude Code chat transcript? */
export function looksLikeTranscript(text) {
  const head = text.slice(0, 20000); // cheap peek — never split the whole file
  // Gemini CLI: a single JSON object with a messages[] of user/gemini turns.
  const ls = head.trimStart();
  if (ls.startsWith("{") && /"messages"\s*:\s*\[/.test(head) && /"type"\s*:\s*"(user|gemini)"/.test(head)) return true;
  let checked = 0, hits = 0;
  for (const raw of head.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    checked++;
    try {
      const o = JSON.parse(line);
      // Codex CLI rollout: session_meta is a distinctive first marker.
      if (o.type === "session_meta") return true;
      if (o.type === "event_msg" && (o.payload?.type === "user_message" || o.payload?.type === "agent_message")) { hits++; continue; }
      const m = o.message || o;
      const role = m.role || o.type;
      if (role === "user" || role === "assistant" || o.type === "summary" || o.sessionId || o.uuid) hits++;
    } catch { /* slice may truncate the last line */ }
    if (checked >= 25) break;
  }
  return checked >= 3 && hits / checked >= 0.6;
}

// Normalize any of the three transcript formats to { agent, blocks, truncated },
// where blocks are [{ role:"user"|"assistant", prose, toolCalls }] in order.
function parseTranscript(text) {
  const ls = text.trimStart();
  // Gemini CLI: { messages: [{ type:"user"|"gemini", content }] } (parse whole — it's one session).
  if (ls.startsWith("{") && /"messages"\s*:\s*\[/.test(text.slice(0, 4000))) {
    const blocks = [];
    try {
      const o = JSON.parse(text);
      for (const m of o.messages || []) {
        const role = m.type === "user" ? "user" : "assistant";
        const c = m.content;
        let prose = Array.isArray(c) ? c.map((x) => x.text || "").join("") : typeof c === "string" ? c : "";
        prose = prose.trim();
        if (prose) blocks.push({ role, prose, toolCalls: 0 });
      }
    } catch { /* malformed */ }
    return { agent: "Gemini", blocks, truncated: false };
  }
  // JSONL: Claude or Codex. Byte-tail huge files (Claude transcripts run to 100s of MB).
  let slice = text, truncated = false;
  if (text.length > CONV_TAIL) {
    slice = text.slice(text.length - CONV_TAIL);
    const nl = slice.indexOf("\n");
    if (nl >= 0) slice = slice.slice(nl + 1);
    truncated = true;
  }
  let agent = "Claude";
  const blocks = [];
  for (const raw of slice.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "session_meta") { agent = "Codex"; continue; }
    // Codex rollout: clean conversational turns.
    if (o.type === "event_msg" && o.payload) {
      if (o.payload.type === "user_message" && o.payload.message) { agent = "Codex"; blocks.push({ role: "user", prose: String(o.payload.message).trim(), toolCalls: 0 }); }
      else if (o.payload.type === "agent_message" && o.payload.message) { agent = "Codex"; blocks.push({ role: "assistant", prose: String(o.payload.message).trim(), toolCalls: 0 }); }
      continue;
    }
    // Claude Code transcript.
    const m = o.message || o;
    const role = m.role || o.type;
    if (role !== "user" && role !== "assistant") continue;
    let prose = "", toolCalls = 0;
    const c = m.content;
    if (typeof c === "string") prose = c;
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && typeof b.text === "string") prose += (prose ? "\n\n" : "") + b.text;
        else if (b.type === "tool_use") toolCalls++;
      }
    }
    prose = prose.trim();
    if (!prose && !(role === "assistant" && toolCalls)) continue;
    blocks.push({ role, prose, toolCalls });
  }
  return { agent, blocks, truncated };
}

const CONV_TAIL = 800000; // distill from the last ~800 KB (recency + DOM sanity)
const CONV_MAX_MSGS = 150;

/** Render a Claude Code transcript as a readable conversation (recent window). */
export function renderConversation(container, text) {
  container.innerHTML = "";
  const { agent, blocks, truncated: trimmedTail } = parseTranscript(text);

  let shown = blocks;
  let truncated = trimmedTail;
  if (blocks.length > CONV_MAX_MSGS) { shown = blocks.slice(blocks.length - CONV_MAX_MSGS); truncated = true; }

  const header = document.createElement("div");
  header.className = "conv-header";
  const title = document.createElement("div");
  title.className = "conv-title";
  title.textContent = "Conversation";
  const copy = document.createElement("button");
  copy.className = "conv-copy";
  copy.textContent = "Copy conversation";
  copy.addEventListener("click", async () => {
    const md = shown.map((b) => {
      const who = b.role === "assistant" ? `**${agent}:**` : "**You:**";
      const tools = b.toolCalls ? `_(${b.toolCalls} tool call${b.toolCalls === 1 ? "" : "s"})_` : "";
      return `${who}\n\n${b.prose || tools}`.trim();
    }).join("\n\n---\n\n");
    try { await navigator.clipboard.writeText(md); copy.textContent = "Copied ✓"; }
    catch { copy.textContent = "Copy failed"; }
    setTimeout(() => { copy.textContent = "Copy conversation"; }, 1200);
  });
  header.append(title, copy);
  container.appendChild(header);

  if (truncated) {
    const note = document.createElement("div");
    note.className = "conv-note";
    note.textContent = "Showing the most recent part of this conversation.";
    container.appendChild(note);
  }

  for (const b of shown) {
    const row = document.createElement("div");
    row.className = "conv-msg conv-" + (b.role === "assistant" ? "claude" : "you");
    const who = document.createElement("div");
    who.className = "conv-who";
    who.textContent = b.role === "assistant" ? agent : "You";
    row.appendChild(who);
    if (b.prose) {
      const body = document.createElement("div");
      body.className = "conv-body";
      body.innerHTML = convMd.render(b.prose);
      row.appendChild(body);
    }
    if (b.toolCalls) {
      const tools = document.createElement("div");
      tools.className = "conv-tools";
      tools.textContent = `▸ ${b.toolCalls} tool call${b.toolCalls === 1 ? "" : "s"}`;
      row.appendChild(tools);
    }
    container.appendChild(row);
  }

  if (!shown.length) {
    const e = document.createElement("div");
    e.className = "render-empty";
    e.textContent = "No conversation messages in this transcript.";
    container.appendChild(e);
  }

  // Open links externally rather than navigating the app window.
  container.addEventListener("click", (e) => {
    const a = e.target.closest("a[href]");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") || "";
    if (/^https?:|^mailto:/i.test(href)) window.plume?.openExternal?.(href);
  });
}

function parseDelimited(text, delim) {
  const rows = [];
  let row = [], field = "", inQ = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQ = true; i++; continue; }
    if (c === delim) { row.push(field); field = ""; i++; continue; }
    if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    if (c === "\r") { i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export function renderCsv(container, text, isTsv) {
  container.innerHTML = "";
  const rows = parseDelimited(text, isTsv ? "\t" : ",");
  if (!rows.length) {
    const e = document.createElement("div");
    e.className = "render-empty";
    e.textContent = "No rows";
    container.appendChild(e);
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "csv-wrap";
  const table = document.createElement("table");
  table.className = "csv-table";
  const thead = table.createTHead();
  const htr = thead.insertRow();
  const corner = document.createElement("th");
  corner.className = "csv-rownum";
  htr.appendChild(corner);
  rows[0].forEach((h) => {
    const th = document.createElement("th");
    th.textContent = h;
    htr.appendChild(th);
  });
  const tbody = table.createTBody();
  for (let r = 1; r < rows.length; r++) {
    const tr = tbody.insertRow();
    const num = document.createElement("td");
    num.className = "csv-rownum";
    num.textContent = r;
    tr.appendChild(num);
    rows[r].forEach((c) => {
      const td = tr.insertCell();
      td.textContent = c;
    });
  }
  wrap.appendChild(table);
  container.appendChild(wrap);
}
