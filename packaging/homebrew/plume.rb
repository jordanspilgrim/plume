# Homebrew cask for Plume — the human pane for agentic coding.
#
# This file lives in a separate tap repo: `jordanspilgrim/homebrew-plume`
# (create it, then `cp` this file to its `Casks/plume.rb`). Users then run:
#
#     brew install --cask jordanspilgrim/plume/plume
#
# The release CI (.github/workflows/release.yml) builds the DMG and prints the
# version + sha256 to paste below; later, automate the bump with `brew bump-cask-pr`.
cask "plume" do
  version "0.1.0"
  sha256 "REPLACE_WITH_DMG_SHA256"   # shasum -a 256 Plume_<version>_universal.dmg

  url "https://github.com/jordanspilgrim/plume/releases/download/v#{version}/Plume_#{version}_universal.dmg"
  name "Plume"
  desc "Human pane for agentic coding — a markdown editor wired into the agent loop"
  homepage "https://github.com/jordanspilgrim/plume"

  # The in-app auto-updater is NOT wired yet (no tauri-plugin-updater / pubkey), so
  # Homebrew manages upgrades via `brew upgrade --cask plume`. Flip to `auto_updates
  # true` only once the updater is actually configured (see release.yml / SECURITY.md).
  auto_updates false
  depends_on macos: ">= :big-sur"

  app "Plume.app"

  # The `plume` / `plume-mcp` CLIs are installed from inside the app
  # (File ▸ Install 'plume' Shell Command…) so they land on the user's PATH
  # with the right Node shebang. Left out of the cask to avoid clobbering that.

  zap trash: [
    "~/.plume",
    "~/Library/Application Support/com.gabriel.plume",
    "~/Library/Caches/com.gabriel.plume",
    "~/Library/WebKit/com.gabriel.plume",
    "~/Library/Preferences/com.gabriel.plume.plist",
    "~/Library/Saved Application State/com.gabriel.plume.savedState",
  ]
end
