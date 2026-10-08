#!/bin/sh
# Installs allclear — https://github.com/m-peko/allclear
#
#   curl -fsSL https://raw.githubusercontent.com/m-peko/allclear/main/install.sh | sh
#
# Puts the source under ~/.local/lib/allclear and links ~/.local/bin/allclear.
# It does not touch ~/.claude/settings.json — running `allclear` does that, so
# piping this to a shell never changes how your sessions behave.
#
# Override with environment variables:
#   ALLCLEAR_PREFIX=/usr/local   where to install (default ~/.local)
#   ALLCLEAR_REF=some-branch     which git ref to install (default main)

set -eu

REPO="m-peko/allclear"
REF="${ALLCLEAR_REF:-main}"
PREFIX="${ALLCLEAR_PREFIX:-$HOME/.local}"
LIB_DIR="$PREFIX/lib/allclear"
BIN_DIR="$PREFIX/bin"

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m') DIM=$(printf '\033[2m') RED=$(printf '\033[31m')
  GREEN=$(printf '\033[32m') RESET=$(printf '\033[0m')
else
  BOLD='' DIM='' RED='' GREEN='' RESET=''
fi

die() {
  printf '%s\n' "${RED}error:${RESET} $1" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed."
}

need curl
need tar
command -v node >/dev/null 2>&1 || die "Node.js 18 or newer is required. See https://nodejs.org"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 18 ] || die "Node.js 18 or newer is required (found $(node -v))."

TMP_DIR=$(mktemp -d)
# shellcheck disable=SC2064
trap "rm -rf '$TMP_DIR'" EXIT INT TERM

printf '%s\n' "${BOLD}Installing allclear${RESET} ${DIM}($REF)${RESET}"

curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF" \
  | tar -xzf - -C "$TMP_DIR" \
  || die "could not download $REPO@$REF"

# The tarball holds a single top-level directory named after the repo and ref;
# finding it beats hardcoding a name that changes with the ref.
SRC_DIR=$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1)
[ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/bin/allclear.js" ] || die "downloaded archive looks wrong."

mkdir -p "$(dirname "$LIB_DIR")" "$BIN_DIR"
rm -rf "$LIB_DIR"
mv "$SRC_DIR" "$LIB_DIR"
chmod +x "$LIB_DIR/bin/allclear.js"
ln -sf "$LIB_DIR/bin/allclear.js" "$BIN_DIR/allclear"

printf '%s\n' "${GREEN}✓${RESET} installed to ${BOLD}$LIB_DIR${RESET}"
printf '%s\n' "${GREEN}✓${RESET} linked ${BOLD}$BIN_DIR/allclear${RESET}"
printf '\n'

case ":${PATH}:" in
  *":$BIN_DIR:"*)
    printf '%s\n' "Run ${BOLD}allclear${RESET} to set up the hooks and open the dashboard."
    ;;
  *)
    printf '%s\n' "${BOLD}$BIN_DIR is not on your PATH.${RESET} Add it:"
    printf '\n    %s\n\n' "export PATH=\"$BIN_DIR:\$PATH\""
    printf '%s\n' "Then run ${BOLD}allclear${RESET} to set up the hooks and open the dashboard."
    ;;
esac
