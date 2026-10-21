#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

CONFIG="${1:-release}"
# 在已受限的沙箱（CI 容器、agent 环境）里，SwiftPM 编译 manifest 会二次套 sandbox-exec 而失败，
# 此时加 SWIFT_FLAGS=--disable-sandbox 即可。本地终端不用管。
SWIFT_FLAGS="${SWIFT_FLAGS:-}"
swift build -c "$CONFIG" $SWIFT_FLAGS --product TLDesk
BIN="$(swift build -c "$CONFIG" $SWIFT_FLAGS --show-bin-path)/TLDesk"

APP="TLDesk.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/TLDesk"
cp Info.plist "$APP/Contents/Info.plist"
# 图标是设计产物（Tools/make-icon.swift + make-icon.sh 生成），没生成过就让 app 用系统默认图标，
# 不为了一个装饰文件把编译搞失败。
if [ -f Assets/AppIcon.icns ]; then
  cp Assets/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
else
  echo "warn: 缺 Assets/AppIcon.icns，跑 ./make-icon.sh 生成" >&2
fi
printf 'APPL????' > "$APP/Contents/PkgInfo"
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

echo "built: $PWD/$APP"
