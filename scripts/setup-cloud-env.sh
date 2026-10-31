#!/usr/bin/env bash
# Setup for a Claude Code cloud environment (or any Ubuntu x86_64 box) that renders the shorts.
# Installs pinned, checksum-verified releases of EffectCraft, FilmCraft and SoundCraft
# (github.com/storytold) under /opt/craft, links their CLIs into /usr/local/bin, installs the
# board font, and installs the repo's npm dependencies. Safe to run again: it skips what is there.
#
# Use as the environment's setup script (it starts one directory above the repo):
#   bash cloudflare-sandbox-bridge/scripts/setup-cloud-env.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX=/opt/craft

# app  version  sha256 of <app>-<version>-linux-x86_64.tar.gz (from each release's SHA256SUMS.txt)
APPS=(
  "effectcraft 0.19.0 7ec9391dae775f7ce7e7291268f7b1233228c1bade83ced8840303535c951970"
  "filmcraft   0.15.0 22b106b4ca6294d9b3e9a4af40b40a653a1897437364805046a01ddbaa4b22c1"
  "soundcraft  0.15.0 16ef23ef62ec20f5fcc53e04abaaff527095e505f5608b47ab1b72b1c8e9ed20"
)

mkdir -p "$PREFIX"
for entry in "${APPS[@]}"; do
  read -r app version sum <<<"$entry"
  dest="$PREFIX/$app"
  if [ -f "$dest/.version" ] && [ "$(cat "$dest/.version")" = "$version" ]; then
    echo "$app $version already installed"
  else
    name="$app-$version-linux-x86_64"
    tmp="$(mktemp -d)"
    curl -fsSL --retry 3 -o "$tmp/$name.tar.gz" \
      "https://github.com/storytold/$app/releases/download/v$version/$name.tar.gz"
    echo "$sum  $tmp/$name.tar.gz" | sha256sum -c --quiet -
    rm -rf "$dest" && mkdir -p "$dest"
    tar -xzf "$tmp/$name.tar.gz" -C "$dest" --strip-components=1
    echo "$version" >"$dest/.version"
    rm -rf "$tmp"
    echo "$app $version installed"
  fi
  ln -sf "$dest/bin/$app-cli" "/usr/local/bin/$app-cli"
done

# The board's hand-drawn font (OFL, vendored next to the woff2 the page uses).
install -D -m 644 "$ROOT/scripts/shorts/page/fonts/Kalam-Bold.ttf" /usr/local/share/fonts/Kalam-Bold.ttf
command -v fc-cache >/dev/null && fc-cache -f /usr/local/share/fonts >/dev/null || true

command -v ffmpeg >/dev/null || { apt-get update -qq && apt-get install -y -qq ffmpeg; }

(cd "$ROOT" && npm ci --no-audit --no-fund)

for app in effectcraft filmcraft soundcraft; do "$app-cli" --version 2>/dev/null || "$app-cli" --help >/dev/null; done
echo "setup done"
