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
