#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLICATIONS_APP="/Applications/Orchestra.app"
SOURCE_ICON="$ROOT_DIR/assets/orchestra_app_icon.png"
BUILD_ICON="$ROOT_DIR/build/icon.icns"
SIGN_APP=false
INSTALL_TO_APPLICATIONS=false

usage() {
  echo "Usage: $0 [--sign] [--install-applications]" >&2
  echo "  Default: rebuild icons and leave Orchestra.app under dist/ (does not touch /Applications)." >&2
  echo "  HOST=0.0.0.0 $0: bake HOST into the rebuilt desktop app." >&2
  echo "  --install-applications: replace $APPLICATIONS_APP and remove the dist/ build folder afterward." >&2
  exit 1
}

for arg in "$@"; do
  case "$arg" in
    --sign)
      SIGN_APP=true
      ;;
    --install-applications)
      INSTALL_TO_APPLICATIONS=true
      ;;
    -h|--help)
      usage
      ;;
    *)
      usage
      ;;
  esac
done

cd "$ROOT_DIR"

echo "Regenerating menu bar tray (template PNG + @2x) from SVG and desktop .icns from PNG..."
if [[ ! -f "$SOURCE_ICON" ]]; then
  echo "Missing source icon: $SOURCE_ICON" >&2
  exit 1
fi

mkdir -p "$ROOT_DIR/build"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
ICONSET="$TMP_DIR/icon.iconset"
mkdir "$ICONSET"

# Baked on every run: edit assets/orchestra_menubar_icon.svg, then ./rebuild.sh
TRAY_SVG="$ROOT_DIR/assets/orchestra_menubar_icon.svg"
TRAY_PNG="$ROOT_DIR/assets/orchestra_tray_template.png"
TRAY_PNG_2X="${TRAY_PNG%.png}@2x.png"
if [[ -f "$TRAY_SVG" ]]; then
  # Blur happens with a single low-res PNG: Retina upscales it. macOS expects @1x + @2x
  # (Electron loads orchestra_tray_template@2x.png next to the base name on darwin).
  # Bump SVG pixel size for rasterization only, then downsample — sharper than upscaling 18→32.
  sed 's/width="18" height="18"/width="256" height="256"/' "$TRAY_SVG" >"$TMP_DIR/tray_raster.svg"
  # ~20pt menu extra: 20 px @1x + 40 px @2x (sharp on Retina; tweak sizes together if needed).
  echo "Writing $TRAY_PNG and $TRAY_PNG_2X from $TRAY_SVG (20 + 40 px template PNGs)..."
  sips -s format png "$TMP_DIR/tray_raster.svg" --out "$TMP_DIR/tray_hi.png" >/dev/null
  sips -z 22 22 "$TMP_DIR/tray_hi.png" --out "$TRAY_PNG" >/dev/null
  sips -z 44 44 "$TMP_DIR/tray_hi.png" --out "$TRAY_PNG_2X" >/dev/null
else
  echo "Warning: missing $TRAY_SVG — skipping orchestra_tray_template(.png|@2x.png)." >&2
fi

sips -z 16 16 "$SOURCE_ICON" --out "$ICONSET/icon_16x16.png" >/dev/null
sips -z 32 32 "$SOURCE_ICON" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$SOURCE_ICON" --out "$ICONSET/icon_32x32.png" >/dev/null
sips -z 64 64 "$SOURCE_ICON" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$SOURCE_ICON" --out "$ICONSET/icon_128x128.png" >/dev/null
sips -z 256 256 "$SOURCE_ICON" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$SOURCE_ICON" --out "$ICONSET/icon_256x256.png" >/dev/null
sips -z 512 512 "$SOURCE_ICON" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$SOURCE_ICON" --out "$ICONSET/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$SOURCE_ICON" --out "$ICONSET/icon_512x512@2x.png" >/dev/null
iconutil -c icns "$ICONSET" -o "$BUILD_ICON"

echo "Removing dist/..."
rm -rf "$ROOT_DIR/dist"

if [[ "$INSTALL_TO_APPLICATIONS" == true ]]; then
  echo "Removing installed app at $APPLICATIONS_APP..."
  rm -rf "$APPLICATIONS_APP"
fi

if [[ "$SIGN_APP" == true ]]; then
  # Sign with a STABLE identity so macOS keeps its TCC grants (Accessibility / Automation)
  # across rebuilds. Ad-hoc signing (the default path below) changes the app's signature
  # every build, so macOS treats each rebuild as a new app and the permissions reset.
  # Identity precedence: $ORCHESTRA_SIGN_IDENTITY, else the first valid code-signing
  # identity in the keychain (by SHA-1, so names with spaces/parens don't need quoting).
  # hardenedRuntime is forced off: this is a locally-installed, non-notarized app, and off
  # keeps it behaving exactly like the ad-hoc build (spawning the server, running the AX
  # helper binaries) with no entitlements needed — the only change is a persistent identity.
  SIGN_IDENTITY="${ORCHESTRA_SIGN_IDENTITY:-}"
  if [[ -z "$SIGN_IDENTITY" ]]; then
    SIGN_IDENTITY="$(security find-identity -v -p codesigning | awk '/[0-9]+\)/ {print $2; exit}')"
  fi
  if [[ -z "$SIGN_IDENTITY" ]]; then
    echo "--sign: no code-signing identity found. Set ORCHESTRA_SIGN_IDENTITY or add one in" >&2
    echo "        Keychain Access. Falling back to ad-hoc (permissions will reset each rebuild)." >&2
    CSC_IDENTITY_AUTO_DISCOVERY=false npm run desktop:pack -- -c.mac.identity=null
  else
    echo "Rebuilding desktop app bundle signed with identity: $SIGN_IDENTITY"
    CSC_IDENTITY_AUTO_DISCOVERY=false npm run desktop:pack -- \
      -c.mac.identity="$SIGN_IDENTITY" \
      -c.mac.hardenedRuntime=false
  fi
else
  echo "Rebuilding unsigned desktop app bundle..."
  CSC_IDENTITY_AUTO_DISCOVERY=false npm run desktop:pack -- -c.mac.identity=null
fi

BUILT_APP_PATH="$ROOT_DIR/dist/mac-arm64/Orchestra.app"
if [[ ! -d "$BUILT_APP_PATH" ]]; then
  BUILT_APP_PATH="$ROOT_DIR/dist/mac/Orchestra.app"
fi

if [[ ! -d "$BUILT_APP_PATH" ]]; then
  echo "Could not find built app bundle in dist/mac-arm64 or dist/mac." >&2
  exit 1
fi

if [[ "$INSTALL_TO_APPLICATIONS" == true ]]; then
  BUILT_APP_DIR="$(dirname "$BUILT_APP_PATH")"
  echo "Moving $BUILT_APP_PATH to $APPLICATIONS_APP..."
  mv "$BUILT_APP_PATH" "$APPLICATIONS_APP"
  echo "Removing build output folder $BUILT_APP_DIR..."
  rm -rf "$BUILT_APP_DIR"
  echo "Done. Installed $APPLICATIONS_APP"
else
  echo "Done. Built app: $BUILT_APP_PATH"
  echo "Open it from dist/ or run: ./rebuild.sh --install-applications"
fi
