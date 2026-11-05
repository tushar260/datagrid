#!/usr/bin/env bash
#
# Installs the latest DataGrid release into /Applications.
#
#   curl -fsSL https://raw.githubusercontent.com/tushar260/datagrid/main/install.sh | bash
#
# Optional environment variables:
#   DATAGRID_VERSION      install this version (e.g. 0.1.0) instead of the latest
#   DATAGRID_INSTALL_DIR  install somewhere other than /Applications
#
# The app is ad-hoc signed and not notarized. Files downloaded with curl are not
# quarantined, so macOS Gatekeeper does not block them, and this script also
# clears the quarantine flag as a safeguard.

set -euo pipefail

REPO="tushar260/datagrid"
APP_NAME="DataGrid"
INSTALL_DIR="${DATAGRID_INSTALL_DIR:-/Applications}"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "$APP_NAME is only available for macOS."

case "$(uname -m)" in
  arm64)  ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *)      die "unsupported CPU architecture: $(uname -m)" ;;
esac

for tool in curl ditto shasum; do
  command -v "$tool" >/dev/null 2>&1 || die "'$tool' is required but was not found."
done

# Work out which version to install.
VERSION="${DATAGRID_VERSION:-}"
VERSION="${VERSION#v}"
if [ -z "$VERSION" ]; then
  say "Looking up the latest release..."
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$VERSION" ] || die "could not determine the latest release of $REPO."
fi

TAG="v$VERSION"
ZIP="$APP_NAME-$VERSION-$ARCH-mac.zip"
BASE_URL="https://github.com/$REPO/releases/download/$TAG"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "Downloading $APP_NAME $VERSION ($ARCH)..."
curl -fL --progress-bar -o "$TMP/$ZIP" "$BASE_URL/$ZIP" \
  || die "could not download $BASE_URL/$ZIP (is there a $ARCH build for $TAG?)"

# Verify the download against the checksums published with the release.
if curl -fsSL -o "$TMP/SHA256SUMS.txt" "$BASE_URL/SHA256SUMS.txt"; then
  EXPECTED="$(awk -v f="$ZIP" '$2 == f || $2 == "*" f { print $1 }' "$TMP/SHA256SUMS.txt" | head -n 1)"
  if [ -n "$EXPECTED" ]; then
    ACTUAL="$(shasum -a 256 "$TMP/$ZIP" | awk '{ print $1 }')"
    [ "$EXPECTED" = "$ACTUAL" ] || die "checksum mismatch for $ZIP; not installing."
    say "Checksum verified."
  else
    say "Note: $ZIP is not listed in SHA256SUMS.txt; skipping checksum verification."
  fi
else
  say "Note: no SHA256SUMS.txt found for $TAG; skipping checksum verification."
fi

# Don't replace the app while it is running.
if [ "$INSTALL_DIR" = "/Applications" ] && pgrep -x "$APP_NAME" >/dev/null 2>&1; then
  die "$APP_NAME is running. Quit it and run this script again."
fi

say "Unpacking..."
ditto -x -k "$TMP/$ZIP" "$TMP/unpacked"
[ -d "$TMP/unpacked/$APP_NAME.app" ] || die "the download did not contain $APP_NAME.app."

DEST="$INSTALL_DIR/$APP_NAME.app"
say "Installing to $DEST..."
mkdir -p "$INSTALL_DIR" 2>/dev/null || true
if [ -w "$INSTALL_DIR" ]; then
  SUDO=""
else
  say "$INSTALL_DIR is not writable; using sudo."
  SUDO="sudo"
fi
$SUDO rm -rf "$DEST"
$SUDO ditto "$TMP/unpacked/$APP_NAME.app" "$DEST"

# Safeguard: make sure Gatekeeper's quarantine flag is not set.
$SUDO xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

codesign -v "$DEST" 2>/dev/null || say "Warning: the code signature could not be verified."

say "Done. $APP_NAME $VERSION is installed at $DEST"
say "Your data sources and settings are stored separately and are not touched."
