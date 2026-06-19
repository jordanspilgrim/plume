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
//        get_annotations, write_document.

const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SOCK = process.platform === "win32"
  ? "\\\\.\\pipe\\plume.sock"
  : path.join(os.homedir(), ".plume", "plume.sock");

function sockOnce(reqs) {
  return new Promise((resolve, reject) => {
    const s = net.connect(SOCK);
    const out = [];
    let buf = "";
    s.setTimeout(5000, () => { s.destroy(); reject(new Error("timeout")); });
    s.on("connect", () => { for (const r of reqs) s.write(JSON.stringify(r) + "\n"); });
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
    description: "Read the user's steer-loop notes for a document — margin notes they left on quoted passages telling you what to change. Each note has the quoted text, the user's instruction, a line number, and a resolved flag. Read these, then revise the document accordingly.",
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
    description: "Write content to a file on disk. If the file is open in Plume, it live-reloads. Use this to apply revisions the user asked for via their annotations.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to write." },
        content: { type: "string", description: "Full new file contents." },
      },
      required: ["path", "content"],
    },
    run: async (a) => {
      const r = await plume({ cmd: "writeDocument", path: a.path, content: a.content });
      return r.ok ? `Wrote ${a.path}.` : `Failed: ${r.error}`;
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
