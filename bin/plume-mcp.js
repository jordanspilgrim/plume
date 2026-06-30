#!/usr/bin/env node
"use strict";

// plume-mcp — a Model Context Protocol server that lets an agent (Claude Code,
// Codex, Claude Desktop) read and steer through the Plume editor.
//
// Speaks MCP over stdio (newline-delimited JSON-RPC 2.0) and relays each tool
// call to a running Plume over ~/.plume/plume.sock. Dependency-free, so it runs
// from anywhere with system node:  claude mcp add plume -- plume-mcp
//
// Tools: open_in_plume, get_active_document, get_selection, list_open_files,
//        get_annotations, write_document, get_attachments.

const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

// PLUME_SOCK lets a dev/test harness point at its own socket (mirrors the Electron
// control.js + CLI override); default is the shared one Plume binds.
const SOCK = process.env.PLUME_SOCK || (process.platform === "win32"
  ? "\\\\.\\pipe\\plume.sock"
  : path.join(os.homedir(), ".plume", "plume.sock"));

// Attachments are routed per project: Plume stages under
// ~/.plume/attachments/<dashify(cwd)>/, and this server — spawned with the
// session's working dir — reads only its own project's bucket. dashify matches
// Claude Code's ~/.claude/projects naming (/ and . -> -).
const dashify = (p) => p.replace(/[/.]/g, "-");
// PLUME_ATTACH_DIR overrides the bucket for tests; production is project-scoped.
const ATTACH_DIR = process.env.PLUME_ATTACH_DIR
  || path.join(os.homedir(), ".plume", "attachments", dashify(process.cwd()));

// ---- write containment (P0-1) ----
// This server is spawned in the agent's workspace; the agent can't change our cwd,
// so anchoring write_document to it (plus whatever the user already has open in
// Plume) stops a prompt-injected agent from turning write_document into an arbitrary
// write — ~/.ssh/authorized_keys, a sibling repo, a .git/hooks/pre-commit. The Rust
// side re-checks this as a backstop; doing it here too gives the agent a clear,
// structured refusal instead of a generic failure. See SECURITY.md.
const WORKSPACE = process.cwd();

// Resolve symlinks/.. on the existing portion of a path so the containment check
// can't be fooled by `workspace/../../etc/x` or a symlink out of the tree.
function canonicalize(p) {
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch { /* target not on disk yet */ }
  try { return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); }
  catch { return abs; }
}

function withinDir(target, dir) {
  const rel = path.relative(dir, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// null = allowed; otherwise an agent-facing refusal string.
function refuseWrite(target, workspace, openPaths = []) {
  const t = canonicalize(target);
  if (withinDir(t, canonicalize(workspace))) return null;
  if (openPaths.some((p) => canonicalize(p) === t)) return null;
  return `Refused: ${target} is outside this workspace (${workspace}) and is not open in Plume. `
    + `Open it in Plume first, or write to a path inside the workspace.`;
}

// Handshake token Plume writes to ~/.plume/token (0600). Read per send so a
// freshly-launched Plume's token is picked up. PLUME_TOKEN overrides for tests.
function authToken() {
  if (process.env.PLUME_TOKEN !== undefined) return process.env.PLUME_TOKEN;
  try { return fs.readFileSync(path.join(os.homedir(), ".plume", "token"), "utf8").trim(); }
  catch { return ""; }
}

function sockOnce(reqs) {
  return new Promise((resolve, reject) => {
    const s = net.connect(SOCK);
    const out = [];
    let buf = "";
    const token = authToken();
    s.setTimeout(5000, () => { s.destroy(); reject(new Error("timeout")); });
    s.on("connect", () => { for (const r of reqs) s.write(JSON.stringify({ ...r, token }) + "\n"); });
    s.on("data", (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.trim()) out.push(JSON.parse(line));
        if (out.length >= reqs.length) { s.end(); resolve(out); return; }
      }
    });
    s.on("error", reject);
  });
}

async function plume(req) {
  try {
    const [res] = await sockOnce([req]);
    return res;
  } catch {
    // Launch Plume, wait for the socket, retry once.
    if (process.platform === "darwin") spawn("open", ["-a", "Plume"], { stdio: "ignore", detached: true }).unref();
    else if (process.platform === "win32") spawn("cmd", ["/c", "start", "", "Plume"], { stdio: "ignore", detached: true }).unref();
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
      try { const [res] = await sockOnce([req]); return res; } catch { /* keep polling */ }
    }
    return { ok: false, error: "Plume is not reachable (install Plume.app in /Applications)." };
  }
}

// ---- MCP tool definitions ----
const TOOLS = [
  {
    name: "open_in_plume",
    description: "Open a file in the Plume editor (the user's reading pane) and bring it to the front. Use this to surface a plan, spec, report, or any file you want the user to read.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file to open." },
        line: { type: "number", description: "Optional 1-based line to jump to." },
      },
      required: ["path"],
    },
    run: async (a) => {
      const r = await plume({ cmd: "open", path: a.path, line: a.line });
      return r.ok ? `Opened ${a.path}${a.line ? " at line " + a.line : ""} in Plume.` : `Failed: ${r.error}`;
    },
  },
  {
    name: "get_active_document",
    description: "Get the path and full current text of the document the user is viewing in Plume (includes unsaved edits).",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const r = await plume({ cmd: "getActiveDocument" });
      if (!r.ok) return `No active document: ${r.error}`;
      return JSON.stringify({ path: r.path, mode: r.mode, dirty: r.dirty, content: r.content });
    },
  },
  {
    name: "get_selection",
    description: "Get the text the user currently has selected in Plume, with its path and line range. Use this to know what the user is pointing at.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const r = await plume({ cmd: "getSelection" });
      if (!r.ok) return `No selection: ${r.error}`;
      return JSON.stringify({ path: r.path, fromLine: r.fromLine, toLine: r.toLine, empty: r.empty, text: r.text });
    },
  },
  {
    name: "list_open_files",
    description: "List the files currently open in Plume windows (path, dirty flag, which is focused).",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const r = await plume({ cmd: "listOpenFiles" });
      return r.ok ? JSON.stringify(r.files) : `Failed: ${r.error}`;
    },
  },
  {
    name: "get_annotations",
    description: "Read the user's typed steering directives for a document — margin notes on quoted passages. Each has: quote (the passage), verdict, note (the user's text), suggestion (optional explicit replacement), line, resolved. The verdict tells you what to do with that passage: 'revise' = change it per note/suggestion; 'reject' = remove or redo it (note says why); 'question' = answer the note, don't just edit; 'approve' = leave it untouched, it's good; 'pin' = must-keep verbatim, do not alter. Apply only the revise/reject passages and answer the questions; leave approve/pin passages alone. After revising, the user reviews your changes as a per-hunk diff, so make each change traceable to its directive.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute file path. Defaults to the active document." } },
    },
    run: async (a) => {
      const r = await plume({ cmd: "getAnnotations", path: a.path });
      if (!r.ok) return `Failed: ${r.error}`;
      return JSON.stringify({ path: r.path, annotations: r.annotations });
    },
  },
  {
    name: "write_document",
    description: "Write content to a file on disk. If the file is open in Plume, it live-reloads. Use this to apply revisions the user asked for via their annotations. For safety, writes are confined to this session's workspace plus files already open in Plume; a path outside that set is refused.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to write (must be inside the workspace or already open in Plume)." },
        content: { type: "string", description: "Full new file contents." },
      },
      required: ["path", "content"],
    },
    run: async (a) => {
      // Gather the user's open files so writes to them are allowed even outside cwd.
      let open = [];
      try {
        const lf = await plume({ cmd: "listOpenFiles" });
        if (lf.ok && Array.isArray(lf.files)) open = lf.files.map((f) => f && f.path).filter(Boolean);
      } catch { /* best-effort; cwd containment still applies */ }
      const refusal = refuseWrite(a.path, WORKSPACE, open);
      if (refusal) return refusal;
      const r = await plume({ cmd: "writeDocument", path: a.path, content: a.content, root: WORKSPACE });
      if (r.ok) return `Wrote ${a.path}.`;
      if (r.code === "dirty_conflict") return `Not written: ${a.path} has unsaved changes open in Plume. Ask the user to save or discard them first, then retry.`;
      if (r.code === "outside_workspace") return `Refused by Plume: ${a.path} is outside the workspace and is not open in Plume.`;
      return `Failed: ${r.error}`;
    },
  },
  {
    name: "get_attachments",
    description: "Read documents the user pushed to you from Plume with its \"Push to agent\" action. Returns each pushed file's name and full content, then clears the queue. When the user says \"read what I pushed\", \"look at the doc I sent you\", or similar, call this.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      let files;
      try {
        files = fs.readdirSync(ATTACH_DIR).filter((f) => f.endsWith(".json")).sort();
      } catch (e) {
        if (e.code === "ENOENT") return "No pending attachments — the user hasn't pushed any documents from Plume.";
        return `Error reading attachments: ${e.message}`;
      }
      if (!files.length) return "No pending attachments — the user hasn't pushed any documents from Plume.";
      const items = [];
      let quarantined = 0;
      for (const f of files) {
        const fp = path.join(ATTACH_DIR, f);
        let parsed = null;
        try { parsed = JSON.parse(fs.readFileSync(fp, "utf8")); } catch { parsed = null; }
        if (parsed) {
          items.push(parsed);
          try { fs.unlinkSync(fp); } catch { /* best-effort consume */ }
        } else {
          // Don't silently destroy a malformed push (P2-7) — quarantine it for
          // inspection instead of unlinking, so a corrupt write is recoverable.
          try {
            const bad = path.join(ATTACH_DIR, ".bad");
            fs.mkdirSync(bad, { recursive: true });
            fs.renameSync(fp, path.join(bad, f));
            quarantined++;
          } catch { /* if we can't move it, leave it in place rather than lose it */ }
        }
      }
      const out = items.map((it) => ({ name: it.name, pushedAt: it.pushedAt, content: it.content }));
      if (quarantined) {
        return JSON.stringify({
          attachments: out,
          warning: `${quarantined} malformed attachment(s) could not be parsed and were moved to ${path.join(ATTACH_DIR, ".bad")} for inspection.`,
        });
      }
      return JSON.stringify(out);
    },
  },
];

// ---- MCP stdio JSON-RPC loop ----
const PROTOCOL_VERSION = "2024-11-05";
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function fail(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "plume", version: "0.1.0" },
    });
  } else if (method === "tools/list") {
    reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  } else if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) { fail(id, -32602, `Unknown tool: ${params?.name}`); return; }
    try {
      const text = await tool.run(params.arguments || {});
      reply(id, { content: [{ type: "text", text: String(text) }] });
    } catch (err) {
      reply(id, { content: [{ type: "text", text: `Error: ${err.message || err}` }], isError: true });
    }
  } else if (method === "ping") {
    reply(id, {});
  } else if (id !== undefined) {
    fail(id, -32601, `Method not found: ${method}`);
  }
  // notifications (no id) — ignore
}

// Exported for the contract tests (test/). Importing the module must NOT start the
// stdio server or print the banner — those run only when invoked as a binary.
module.exports = { refuseWrite, withinDir, canonicalize, PROTOCOL_VERSION, TOOLS };

function startServer() {
  // Greet on stderr only when run in a real terminal (manual / debug). When an
  // agent spawns us it pipes stderr, so this stays silent and never touches the
  // stdout JSON-RPC stream.
  if (process.stderr.isTTY) {
    const grad = [147, 111, 105, 99, 63, 57];
    const art = [
      "██████╗ ██╗     ██╗   ██╗███╗   ███╗███████╗",
      "██╔══██╗██║     ██║   ██║████╗ ████║██╔════╝",
      "██████╔╝██║     ██║   ██║██╔████╔██║█████╗  ",
      "██╔═══╝ ██║     ██║   ██║██║╚██╔╝██║██╔══╝  ",
      "██║     ███████╗╚██████╔╝██║ ╚═╝ ██║███████╗",
      "╚═╝     ╚══════╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝",
    ].map((l, i) => `  \x1b[38;5;${grad[i] || 105}m${l}\x1b[0m`).join("\n");
    process.stderr.write(`\n${art}\n\n  \x1b[2mMCP server — waiting for an agent on stdio…\x1b[0m\n\n`);
  }

  let stdinBuf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    stdinBuf += chunk;
    let i;
    while ((i = stdinBuf.indexOf("\n")) >= 0) {
      const line = stdinBuf.slice(0, i); stdinBuf = stdinBuf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      handle(msg);
    }
  });
  process.stdin.on("end", () => process.exit(0));
}

if (require.main === module) startServer();
