# plume-mcp

The MCP server + `plume` CLI for [Plume](https://github.com/jordanspilgrim/plume) —
the human pane for agentic coding.

```bash
npm install -g plume-mcp
# then, in your agent of choice:
claude mcp add plume -- plume-mcp
# (or: codex mcp add plume -- plume-mcp  /  gemini mcp add plume -- plume-mcp)
```

Requires the Plume desktop app to be installed (the CLI/MCP talk to it over a local
socket). Zero runtime dependencies — pure Node built-ins.

## Tools

`open_in_plume`, `get_active_document`, `get_selection`, `list_open_files`,
`get_annotations`, `write_document`, `get_attachments`.

See the main repo for the full protocol and the security model (`SECURITY.md`).
