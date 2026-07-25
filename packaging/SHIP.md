# Shipping & Distribution — Plume

## TL;DR distribution strategy

**Primary: direct download (Developer-ID signed + notarized) + Homebrew cask.**
This is how developer-tool peers ship (Marky, VMark, ZenNotes). No sandbox, so
the moat works: CLI, `plume-mcp`, the Unix socket, and reading `~/.claude` /
`~/.codex` / `~/.gemini`.

**The Mac App Store is NOT a fit for full Plume.** MAS requires the App Sandbox,
which forbids the exact things that make Plume Plume:
- spawning the `plume-mcp` Node process,
- binding the Unix socket at `~/.plume/plume.sock`,
- reading agent session dirs (`~/.claude`, `~/.codex`, `~/.gemini`),
- installing the `plume`/`plume-mcp` CLIs to the PATH.

A MAS build would be a neutered viewer/editor with none of the steering loop —
i.e. OpenMark, which *is* on the App Store precisely because it's only a viewer.
If you want App Store presence, do it as a **separate "Plume Viewer" funnel app**
(read-only, sandbox-safe) that links out to the full direct download — not as the
primary channel. See "Mac App Store (optional funnel)" below.

---

## 1. One-time Apple setup

1. Enroll in the **Apple Developer Program** ($99/yr).
2. Create a **Developer ID Application** certificate (Xcode ▸ Settings ▸ Accounts
   ▸ Manage Certificates ▸ +, or the Developer portal). Export it as a `.p12`.
3. Create an **app-specific password** for notarization (appleid.apple.com ▸
   Sign-In and Security ▸ App-Specific Passwords).
4. Note your **Team ID** (10 chars, Developer portal ▸ Membership).

## 2. Repo secrets (Settings ▸ Secrets ▸ Actions)

The release workflow (`.github/workflows/release.yml`) reads:

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | `base64 -i DeveloperID.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | the `.p12` password |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Your Name (TEAMID)` |
| `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | the app-specific password |
| `APPLE_TEAM_ID` | your Team ID |
| `TAURI_SIGNING_PRIVATE_KEY` | updater key (step 4) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password |

## 2b. Export sidecar (lazy app-local Node — app stays tiny)

DOCX export and Google Docs publish run in a small helper process built from
`bin/plume-sidecar.js` (bundled to a single `.cjs` resource by
`scripts/build-tauri.mjs`). It needs a Node runtime, which is **not** bundled —
that would add ~50 MB and kill the "tiny app" positioning. Instead the runtime
is resolved lazily, in order:

1. **Plume's private Node** at `<app_data_dir>/node/bin/node` (installed by the
   in-app flow below; survives app updates).
2. **`node` reachable from the process** — including `/opt/homebrew/bin` and
   `/usr/local/bin`, which GUI-launched apps don't have on their minimal PATH.
3. Neither → export returns a structured `NODE_MISSING` error and the renderer
   offers **"Enable export (one-time ~40 MB download)"**. Accepting invokes the
   `install_node` command: it downloads the official pinned-LTS tarball for the
   host arch from nodejs.org over HTTPS, **verifies it against Node's published
   `SHASUMS256.txt`**, extracts only `bin/node` into the app data dir, and the
   renderer retries the export. No sudo, no system PATH changes. Declined or
   offline → clear "export needs Node" message; the rest of Plume is unaffected.

## 3. Cut a release

```bash
# bump version in src-tauri/tauri.conf.json + package.json, commit, then:
git tag v0.1.0 && git push origin v0.1.0
```

The `release` workflow builds a **universal** (Apple Silicon + Intel) app, signs +
notarizes it, and opens a **draft** GitHub Release with the DMG + `latest.json`
(the updater feed). Review the draft, then publish.

> The repo is currently **private**. For public direct downloads + Homebrew, make
> it public (or host releases in a separate public repo).

## 4. Enable auto-update (when ready)

Updates need an updater keypair you own. The committed config does **not** yet
enable it so local `tauri build` stays keyless.

```bash
npx tauri signer generate -w ~/.plume-updater.key   # keep the private key SAFE
# → prints a public key; set the private key + its password as the TAURI_SIGNING_* secrets
```

Then apply this patch:

**`src-tauri/tauri.conf.json`** — add to `bundle`: `"createUpdaterArtifacts": true`,
and add a `plugins.updater` block:
```json
"updater": {
  "endpoints": ["https://github.com/jordanspilgrim/plume/releases/latest/download/latest.json"],
  "pubkey": "PASTE_YOUR_GENERATED_PUBLIC_KEY"
}
```
*(example pubkey format, replace it: `dW50cnVzdGVkIGNvbW1lbnQ6...`)*

**`src-tauri/Cargo.toml`** — `tauri-plugin-updater = "2"` and `tauri-plugin-process = "2"`.
**`src-tauri/src/main.rs`** — `.plugin(tauri_plugin_updater::Builder::new().build())`
and `.plugin(tauri_plugin_process::init())`.
**`src-tauri/capabilities/*.json`** — add `"updater:default"`, `"process:default"`.
**Renderer (Tauri bridge)** — on launch, `check()` from `@tauri-apps/plugin-updater`;
if an update is found, prompt and `downloadAndInstall()` then `relaunch()`.

Local builds with `createUpdaterArtifacts: true` need `TAURI_SIGNING_PRIVATE_KEY`
in the env; CI has it from the secret.

## 5. Homebrew cask

1. Create a public repo **`jordanspilgrim/homebrew-plume`**.
2. Copy `packaging/homebrew/plume.rb` to its `Casks/plume.rb`, fill `version` + the DMG
   `sha256` (`shasum -a 256 Plume_<v>_universal.dmg`).
3. Users install with:
   ```bash
   brew install --cask jordanspilgrim/plume/plume
   ```
4. On each release, `brew bump-cask-pr` (or a small CI job) updates version + sha.

## 6. Mac App Store (optional funnel — separate app)

Only if you want store presence. Build a **read-only "Plume Viewer"** target:
sandboxed, user-opens-files only, no CLI/MCP/socket, no agent-dir browsing. List
it as Developer Tools, with a "Get the full Plume" link. Keep it a marketing
funnel, never the product.

## 7. Cross-platform (later)

CI already builds Windows/Linux (`build.yml`). For distribution:
- **Windows**: `winget` manifest + an Authenticode cert (or ship unsigned with a
  SmartScreen warning initially); optional Microsoft Store (non-sandboxed Win32).
- **Linux**: `.deb` + AppImage from the build (already produced), plus an AUR
  `PKGBUILD` and/or Flathub manifest.
