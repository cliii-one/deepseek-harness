#!/bin/bash
set -euo pipefail

# Build .fpk for DeepSeek Harness
# Usage: bash build-fpk.sh [version] [platform]
#   version  - override version (default: from manifest)
#   platform - x86 | arm (default: x86)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"
APP_DIR="$REPO_ROOT/deepseek-harness"

VERSION="${1:-}"
PLATFORM="${2:-x86}"

case "$PLATFORM" in
    x86|x86_64|amd64)
        NORM_PLATFORM="x86"
        TAR_FILE="${REPO_ROOT}/app_amd64.tgz"
        ;;
    arm|arm64|aarch64)
        NORM_PLATFORM="arm"
        TAR_FILE="${REPO_ROOT}/app_arm64.tgz"
        ;;
    *)
        NORM_PLATFORM="$PLATFORM"
        TAR_FILE="${REPO_ROOT}/app_${PLATFORM}.tgz"
        ;;
esac

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
info() { echo -e "${GREEN}[INFO]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

if [ ! -f "$TAR_FILE" ] && [ -f "${REPO_ROOT}/app.tgz" ]; then
    echo -e "${RED}[WARN]${NC} 未找到 ${TAR_FILE##*/}，回退到 app.tgz——请确认其架构与目标平台一致！"
    TAR_FILE="${REPO_ROOT}/app.tgz"
fi

[ -d "$APP_DIR" ] || error "App directory not found: $APP_DIR"
[ -f "$TAR_FILE" ] || error "Target archive not found: $TAR_FILE — run build.sh first"

# Validate required files
for f in manifest cmd config ICON.PNG ICON_256.PNG; do
    [ -e "$APP_DIR/$f" ] || error "Missing: $APP_DIR/$f"
done
[ -d "$APP_DIR/app/ui" ] || error "Missing app/ui/ directory"

# Read appname
APPNAME=$(grep "^appname[[:space:]]*=" "$APP_DIR/manifest" | awk -F'=' '{print $2}' | tr -d ' ')
[ -n "$APPNAME" ] || error "Cannot read appname from manifest"

info "Building fpk for: $APPNAME (platform: $NORM_PLATFORM)"

CHECKSUM=$(md5sum "$TAR_FILE" | cut -d' ' -f1)

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT
PKG_DIR="$WORK_DIR/package"
mkdir -p "$PKG_DIR/cmd"

# 1. app.tgz (应用运行文件: Node.js + DSH + runner.js)
cp "$TAR_FILE" "$PKG_DIR/app.tgz"

# 2. cmd (生命周期脚本)
cp -a "$APP_DIR/cmd/." "$PKG_DIR/cmd/"

# 3. config (权限和资源声明)
cp -a "$APP_DIR/config" "$PKG_DIR/config"

# 4. wizard (安装向导)
if [ -d "$APP_DIR/wizard" ]; then
    cp -a "$APP_DIR/wizard" "$PKG_DIR/"
fi

# 5. 防火墙配置
cp "$APP_DIR"/*.sc "$PKG_DIR/" 2>/dev/null || true

# 6. 图标
cp "$APP_DIR"/ICON*.PNG "$PKG_DIR/" 2>/dev/null || true

# 7. ui (桌面入口配置)
cp -a "$APP_DIR/app/ui" "$PKG_DIR/"
if [ -d "$PKG_DIR/ui/images" ] && [ -f "$PKG_DIR/ICON_256.PNG" ]; then
    cp "$PKG_DIR/ICON_256.PNG" "$PKG_DIR/ui/images/256.png"
fi

# 8. 设置权限
find "$PKG_DIR" -type d -exec chmod 755 {} +
find "$PKG_DIR" -type f -exec chmod 644 {} +
chmod -R 755 "$PKG_DIR/cmd"
if [ -d "$PKG_DIR/wizard" ]; then
    chmod -R 755 "$PKG_DIR/wizard"
fi

# 9. manifest (更新版本、平台、校验和)
cp "$APP_DIR/manifest" "$PKG_DIR/manifest"
if [ -n "$VERSION" ]; then
    sed -i.tmp "s/^version.*/version         = ${VERSION}/" "$PKG_DIR/manifest"
fi
if grep -q "^platform" "$PKG_DIR/manifest"; then
    sed -i.tmp "s/^platform.*/platform        = ${NORM_PLATFORM}/" "$PKG_DIR/manifest"
else
    echo "platform        = ${NORM_PLATFORM}" >> "$PKG_DIR/manifest"
fi
sed -i.tmp "s/^checksum.*/checksum        = ${CHECKSUM}/" "$PKG_DIR/manifest"
rm -f "$PKG_DIR/manifest.tmp"

# 输出文件名
MANIFEST_VERSION=$(grep "^version[[:space:]]*=" "$PKG_DIR/manifest" | awk -F'=' '{print $2}' | tr -d ' ')
MANIFEST_PLATFORM=$(grep "^platform[[:space:]]*=" "$PKG_DIR/manifest" | awk -F'=' '{print $2}' | tr -d ' ')
FPK_NAME="${APPNAME}_${MANIFEST_VERSION}_${MANIFEST_PLATFORM:-x86}.fpk"

# 10. 打包FPK
cd "$PKG_DIR"
[ -f "app.tgz" ] || error "app.tgz missing"
[ -f "manifest" ] || error "manifest missing"
[ -d "cmd" ] || error "cmd missing"
[ -d "config" ] || error "config missing"
[ -f "ICON.PNG" ] || error "ICON.PNG missing"
[ -f "ICON_256.PNG" ] || error "ICON_256.PNG missing"
tar --owner=0 --group=0 --numeric-owner -czf "$REPO_ROOT/$FPK_NAME" *
cd "$REPO_ROOT"

rm -rf "$WORK_DIR"
trap - EXIT
info "Built: $FPK_NAME ($(du -h "$REPO_ROOT/$FPK_NAME" | cut -f1))"
echo "$FPK_NAME"
