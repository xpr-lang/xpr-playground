#!/usr/bin/env bash
# fetch-pyodide.sh -- reproducible vendoring of Pyodide 0.27.5 + xpr-lang 0.5.0
#
# Usage: bash scripts/fetch-pyodide.sh [--verify-only]
# Exit:  0=ok, 1=network/extract, 2=checksum mismatch, 3=missing tool
#
# WARNING: Pyodide version is pinned by Locked Decision #6 -- ABI changes
# between minors corrupt cached wheels. Coordinate with W3.3 before bumping.

set -euo pipefail

PYODIDE_VERSION="0.27.5"
XPR_LANG_VERSION="0.5.0"

PYODIDE_CORE_URL="https://github.com/pyodide/pyodide/releases/download/${PYODIDE_VERSION}/pyodide-core-${PYODIDE_VERSION}.tar.bz2"
PYODIDE_CORE_SHA256="2e16b053eaa0b1f5761e027e6fc54003567a34e8327bba9a918407accaa4d7c8"

# pyodide-core (5.6 MB) supplies the runtime; the full pyodide tarball is
# 390 MB and contains the same files for our subset. micropip + packaging
# wheels are NOT in pyodide-core -- only in jsdelivr CDN or full tarball.
# We MUST use Pyodide's build-patched copies (not PyPI) because Pyodide
# verifies them against pyodide-lock.json at runtime.
PYODIDE_CDN_BASE="https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full"

PYODIDE_FILES=(
  pyodide.asm.js
  pyodide.asm.wasm
  pyodide.mjs
  python_stdlib.zip
  pyodide-lock.json
  package.json
)

PYODIDE_FILE_SHA256=(
  "pyodide.asm.js:3a889f073e628c2196c705b42fa0e955ba2e25c034b1e3dd589c35be675bc01b"
  "pyodide.asm.wasm:f7fefe563134714a17abd65516d94960e8dbd96fe6778a7a842947fc9686b3a1"
  "pyodide.mjs:6bc4d7b4f6308c4bacd3aa784d7471ead9bf45f239aa5eb431815d6f1cffe58e"
  "python_stdlib.zip:6030964967e447c887abc46c5f0967c55688644d759496de82a3ef09f49f5cba"
  "pyodide-lock.json:be1807745da93daa09d360b109c17a0e526e74d664d1f1b9870aafcce98ce426"
  "package.json:7e55ee9d209ff136bc80917986d835ff407e7d6aff17008e88238ae0be5f9184"
  "micropip-0.8.0-py3-none-any.whl:b496f99fdcc46fcce8c41f3f5ecba5b368f582ce01b3501cd3f8670cb0039398"
  "packaging-24.2-py3-none-any.whl:8702ed5471ec290c11d7b7792d70159ecb47b0dc476a5606acd891609a9ff7d0"
)

PYODIDE_PACKAGE_WHEELS=(
  "micropip-0.8.0-py3-none-any.whl:b496f99fdcc46fcce8c41f3f5ecba5b368f582ce01b3501cd3f8670cb0039398"
  "packaging-24.2-py3-none-any.whl:8702ed5471ec290c11d7b7792d70159ecb47b0dc476a5606acd891609a9ff7d0"
)

WHEEL_NAME="xpr_lang-${XPR_LANG_VERSION}-py3-none-any.whl"
WHEEL_SHA256="b5276c43640406e56509438dceafe9b6ff771296aa8c70824a99d87d4a27088e"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLAYGROUND_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
VENDOR_DIR="${PLAYGROUND_ROOT}/public/vendor"
PYODIDE_DIR="${VENDOR_DIR}/pyodide-${PYODIDE_VERSION}"
WHEELS_DIR="${VENDOR_DIR}/wheels"

log()  { printf '[fetch-pyodide] %s\n' "$*"; }
fail() { printf '[fetch-pyodide] ERROR: %s\n' "$*" >&2; exit "${2:-1}"; }

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required tool: $1" 3
}

sha256_of() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
  else
    fail "neither sha256sum nor shasum found" 3
  fi
}

verify_file() {
  local file="$1" expected="$2"
  [ -f "$file" ] || { log "MISSING: $file"; return 2; }
  local actual; actual="$(sha256_of "$file")"
  if [ "$actual" = "$expected" ]; then
    log "OK       $(basename "$file")  $actual"
    return 0
  else
    log "MISMATCH $(basename "$file")"
    log "  expected $expected"
    log "  actual   $actual"
    return 2
  fi
}

verify_all() {
  local rc=0
  for entry in "${PYODIDE_FILE_SHA256[@]}"; do
    local name="${entry%%:*}"
    local sha="${entry##*:}"
    verify_file "${PYODIDE_DIR}/${name}" "$sha" || rc=2
  done
  verify_file "${WHEELS_DIR}/${WHEEL_NAME}" "$WHEEL_SHA256" || rc=2
  return $rc
}

if [ "${1:-}" = "--verify-only" ]; then
  log "verify-only: re-checksumming vendored files"
  verify_all || fail "checksum verification failed" 2
  log "all vendored files match pinned checksums"
  exit 0
fi

if verify_all 2>/dev/null; then
  log "all files already present with matching checksums -- nothing to do"
  log "(use --verify-only to re-check, or delete public/vendor/ to force refresh)"
  exit 0
fi

require_tool curl
require_tool tar
require_tool pip3 || require_tool pip

mkdir -p "$PYODIDE_DIR" "$WHEELS_DIR"

TMPDIR_PYODIDE="$(mktemp -d -t pyodide-fetch.XXXXXX)"
trap 'rm -rf "$TMPDIR_PYODIDE"' EXIT

TARBALL="${TMPDIR_PYODIDE}/pyodide-core-${PYODIDE_VERSION}.tar.bz2"
log "downloading Pyodide core ${PYODIDE_VERSION} (~5.6 MB)"
curl -fsSL -o "$TARBALL" "$PYODIDE_CORE_URL" || fail "Pyodide download failed"

actual="$(sha256_of "$TARBALL")"
if [ "$actual" != "$PYODIDE_CORE_SHA256" ]; then
  fail "tarball SHA256 mismatch (expected $PYODIDE_CORE_SHA256, got $actual)" 2
fi
log "tarball checksum OK"

tar xjf "$TARBALL" -C "$TMPDIR_PYODIDE" || fail "extraction failed"

for f in "${PYODIDE_FILES[@]}"; do
  src="${TMPDIR_PYODIDE}/pyodide/${f}"
  [ -f "$src" ] || fail "expected file missing in tarball: pyodide/$f"
  cp "$src" "${PYODIDE_DIR}/${f}"
done
log "vendored ${#PYODIDE_FILES[@]} Pyodide core files"

for entry in "${PYODIDE_PACKAGE_WHEELS[@]}"; do
  name="${entry%%:*}"
  sha="${entry##*:}"
  dest="${PYODIDE_DIR}/${name}"
  log "downloading ${name}"
  curl -fsSL -o "$dest" "${PYODIDE_CDN_BASE}/${name}" \
    || fail "download failed: ${name}"
  actual="$(sha256_of "$dest")"
  if [ "$actual" != "$sha" ]; then
    fail "${name} SHA256 mismatch (expected $sha, got $actual)" 2
  fi
done
log "vendored ${#PYODIDE_PACKAGE_WHEELS[@]} Pyodide-build wheels"

PIP="$(command -v pip3 || command -v pip)"
log "downloading xpr-lang ${XPR_LANG_VERSION} wheel via ${PIP##*/}"
"$PIP" download "xpr-lang==${XPR_LANG_VERSION}" \
  --no-deps \
  --no-cache-dir \
  --dest "$WHEELS_DIR" \
  --quiet \
  || fail "pip download failed"

[ -f "${WHEELS_DIR}/${WHEEL_NAME}" ] || fail "wheel missing after pip download: ${WHEEL_NAME}"

verify_all || fail "post-download checksum verification failed" 2

log "done -- $(find "$PYODIDE_DIR" "$WHEELS_DIR" -type f | wc -l | tr -d ' ') files vendored"
