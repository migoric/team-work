#!/bin/bash
# 生成 AppIcon.icns。图标是设计产物，不参与每次编译，所以只在改了 Tools/make-icon.swift
# 之后手动跑一次，产物（Assets/AppIcon.icns）随仓库走 —— build.sh 直接拷贝。
set -euo pipefail
cd "$(dirname "$0")"

SET=Assets/AppIcon.iconset
rm -rf "$SET" Assets/AppIcon.icns
swift Tools/make-icon.swift "$SET"
iconutil -c icns "$SET" -o Assets/AppIcon.icns
rm -rf "$SET"
echo "built: $PWD/Assets/AppIcon.icns"
