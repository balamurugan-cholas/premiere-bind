#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SOURCE="$ROOT/companion/macos/Sources/main.swift"
APP="$ROOT/dist/macos/root/Applications/PremiereBind Companion.app"
MACOS="$APP/Contents/MacOS"
RESOURCES="$APP/Contents/Resources"

rm -rf "$ROOT/dist/macos"
mkdir -p "$MACOS" "$RESOURCES"
cp "$ROOT/companion/macos/App/Contents/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/companion/macos/App/Contents/Resources/PremiereBindPackage.icns" "$RESOURCES/PremiereBindPackage.icns"

swiftc -O -target x86_64-apple-macosx10.15 "$SOURCE" -o "$MACOS/PremiereBindCompanion-x86_64"
swiftc -O -target arm64-apple-macosx11.0 "$SOURCE" -o "$MACOS/PremiereBindCompanion-arm64"
lipo -create "$MACOS/PremiereBindCompanion-x86_64" "$MACOS/PremiereBindCompanion-arm64" -output "$MACOS/PremiereBindCompanion"
rm "$MACOS/PremiereBindCompanion-x86_64" "$MACOS/PremiereBindCompanion-arm64"
chmod 755 "$MACOS/PremiereBindCompanion"
codesign --force --deep --sign - "$APP"

mkdir -p "$ROOT/dist/macos/root/Library/Application Support/Adobe/CEP/extensions/com.premierebind.cep"
ditto "$ROOT/extension" "$ROOT/dist/macos/root/Library/Application Support/Adobe/CEP/extensions/com.premierebind.cep"
rm -rf "$ROOT/dist/macos/root/Library/Application Support/Adobe/CEP/extensions/com.premierebind.cep/companion"
mkdir -p "$ROOT/dist/macos/root/Library/LaunchAgents"
cp "$ROOT/installer/macos/com.premierebind.companion.plist" "$ROOT/dist/macos/root/Library/LaunchAgents/com.premierebind.companion.plist"

chmod +x "$ROOT/installer/macos/scripts/preinstall" "$ROOT/installer/macos/scripts/postinstall"
pkgbuild --root "$ROOT/dist/macos/root" --scripts "$ROOT/installer/macos/scripts" --identifier com.premierebind.installer --version 1.0.0 --install-location / "$ROOT/dist/macos/PremiereBind-component.pkg"
productbuild --distribution "$ROOT/installer/macos/distribution.xml" --resources "$ROOT/installer/macos" --package-path "$ROOT/dist/macos" "$ROOT/dist/PremiereBind-1.0.0-macOS-Universal.pkg"

DMG_SOURCE="$ROOT/dist/macos/dmg"
rm -rf "$DMG_SOURCE"
mkdir -p "$DMG_SOURCE"
cp "$ROOT/dist/PremiereBind-1.0.0-macOS-Universal.pkg" "$DMG_SOURCE/PremiereBind Installer.pkg"
cp "$ROOT/installer/macos/README.txt" "$DMG_SOURCE/READ ME - macOS.txt"
hdiutil create -volname "PremiereBind 1.0.0" -srcfolder "$DMG_SOURCE" -ov -format UDZO "$ROOT/dist/PremiereBind-1.0.0-macOS-Universal.dmg"
