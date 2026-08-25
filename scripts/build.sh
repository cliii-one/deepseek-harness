#!/bin/bash
set -euo pipefail

# Build DeepSeek Harness app.tgz for fnOS (.fpk)
# Strategy: bundle Node.js runtime + pre-installed node_modules + runner + ui assets (offline-ready, version-locked)
# 仅支持 Linux/macOS 执行：本脚本会直接运行下载的 linux node 二进制做 npm install
# Reference: apps/feigram from conversun/fnos-apps

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 版本兜底与 Node 版本均以 meta.env 为单一来源
DSH_FALLBACK_VERSION="${DSH_FALLBACK_VERSION:-$(sed -n 's/^DSH_FALLBACK_VERSION=//p' "${SCRIPT_DIR}/meta.env" 2>/dev/null | tr -d '[:space:]')}"
if [ -z "${DSH_FALLBACK_VERSION}" ]; then
    DSH_FALLBACK_VERSION="0.1.1-rc.2"
fi
NODE_VERSION="${NODE_VERSION:-$(sed -n 's/^NODE_VERSION=//p' "${SCRIPT_DIR}/meta.env" 2>/dev/null | tr -d '[:space:]')}"
if [ -z "${NODE_VERSION}" ]; then
    NODE_VERSION="24.4.0"
fi

# 默认自动解析官方 npm 的 next / latest 版本，网络不可达时兜底为 meta.env 中的值
if [ -z "${VERSION:-}" ] || [ "${VERSION}" = "latest" ] || [ "${VERSION}" = "" ]; then
    RESOLVED_VER=$(npm view @deepseek-ai/dsh dist-tags.next 2>/dev/null || true)
    if [ -z "$RESOLVED_VER" ]; then
        RESOLVED_VER=$(npm view @deepseek-ai/dsh@latest version 2>/dev/null || echo "${DSH_FALLBACK_VERSION}")
    fi
    VERSION="${RESOLVED_VER}"
fi

# 内置插件清单与目标 profile 均以 meta.env 为单一来源（空格分隔包名，构建时解析最新版）
BUNDLED_DSH_PLUGINS="${BUNDLED_DSH_PLUGINS:-$(sed -n 's/^BUNDLED_DSH_PLUGINS=//p' "${SCRIPT_DIR}/meta.env" 2>/dev/null)}"
DSH_PLUGIN_PROFILE="${DSH_PLUGIN_PROFILE:-$(sed -n 's/^DSH_PLUGIN_PROFILE=//p' "${SCRIPT_DIR}/meta.env" 2>/dev/null | tr -d '[:space:]')}"
if [ -z "${DSH_PLUGIN_PROFILE}" ]; then
    DSH_PLUGIN_PROFILE="web"
fi

TARBALL_ARCH="${TARBALL_ARCH:-amd64}"
PNPM_VERSION="${PNPM_VERSION:-10.14.0}"
OUTPUT_TGZ="${OUTPUT_TGZ:-${REPO_ROOT}/app_${TARBALL_ARCH}.tgz}"

case "$TARBALL_ARCH" in
  amd64|x86|x64) NODE_ARCH="x64" ;;
  arm64|aarch64|arm) NODE_ARCH="arm64" ;;
  *) echo "Unsupported TARBALL_ARCH=${TARBALL_ARCH}" >&2; exit 1 ;;
esac

NODE_ARCHIVE="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}"

echo "==> Building DeepSeek Harness ${VERSION} for ${TARBALL_ARCH} (Node ${NODE_VERSION})"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# 1. Download Node.js runtime
echo "==> Downloading Node.js ${NODE_VERSION}..."
curl -fL --retry 3 -o "${WORK_DIR}/${NODE_ARCHIVE}" "$NODE_URL"
mkdir -p "${WORK_DIR}/node"
tar -xJf "${WORK_DIR}/${NODE_ARCHIVE}" -C "${WORK_DIR}/node" --strip-components=1
# npm 及其生命周期脚本会通过 PATH 再次查找 node；必须固定到刚下载的
# 运行时，不能依赖 GitHub Actions 或开发机恰好预装的其他版本。
export PATH="${WORK_DIR}/node/bin:${PATH}"

# 2. Install dsh (npm package, includes all deps)
mkdir -p "${WORK_DIR}/dsh-web"
cd "${WORK_DIR}/dsh-web"
"${WORK_DIR}/node/bin/npm" init -y >/dev/null 2>&1
echo "==> Installing @deepseek-ai/dsh@${VERSION}..."

MAX_RETRIES=3
RETRY_COUNT=0
INSTALL_SUCCESS=false

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    RETRY_COUNT=$((RETRY_COUNT + 1))
    if "${WORK_DIR}/node/bin/node" "${WORK_DIR}/node/lib/node_modules/npm/bin/npm-cli.js" install "@deepseek-ai/dsh@${VERSION}" --omit=dev --no-audit --no-fund --prefer-online; then
        INSTALL_SUCCESS=true
        break
    else
        echo "⚠️ npm install 失败 (尝试 $RETRY_COUNT/$MAX_RETRIES)，等待 5 秒后重试..."
        sleep 5
    fi
done

if [ "$INSTALL_SUCCESS" != "true" ]; then
    echo "❌ 安装 @deepseek-ai/dsh@${VERSION} 失败 (已重试 $MAX_RETRIES 次)" >&2
    exit 1
fi

# 3. Assemble app_root (app.tgz content)
mkdir -p "${WORK_DIR}/app_root/bin"
cp "${WORK_DIR}/node/bin/node" "${WORK_DIR}/app_root/bin/node"
chmod +x "${WORK_DIR}/app_root/bin/node"
cp -a "${WORK_DIR}/dsh-web/node_modules" "${WORK_DIR}/app_root/node_modules"
cp "${WORK_DIR}/dsh-web/package.json" "${WORK_DIR}/app_root/package.json" 2>/dev/null || true

# DSH 的 `plugin` 子命令会在 profile 目录直接执行 `pnpm`。此前 FPK 只
# 复制了 node，主题/扩展安装会报 pnpm not found。固定版本随应用打包，
# runner 已将 app_root/bin 放在 PATH 首位。
echo "==> Bundling pnpm ${PNPM_VERSION} for DSH plugin management..."
"${WORK_DIR}/node/bin/npm" install --global --prefix "${WORK_DIR}/app_root" "pnpm@${PNPM_VERSION}" --omit=dev --no-audit --no-fund
test -x "${WORK_DIR}/app_root/bin/pnpm"

# 复制 ui 目录和 runner 脚本至 app_root (解压后位于 ${TRIM_APPDEST})
if [ -d "${REPO_ROOT}/deepseek-harness/app/ui" ]; then
    echo "==> Bundling desktop UI config..."
    cp -r "${REPO_ROOT}/deepseek-harness/app/ui" "${WORK_DIR}/app_root/ui"
fi
if [ -d "${REPO_ROOT}/deepseek-harness/app/bin" ]; then
    echo "==> Bundling runner script..."
    cp -r "${REPO_ROOT}/deepseek-harness/app/bin/." "${WORK_DIR}/app_root/bin/"
    chmod +x "${WORK_DIR}/app_root/bin/"* 2>/dev/null || true
fi

# 3.5 预下载内置插件的 npm tgz（离线种子）。runner.js 在 NAS 上首次启动时
# 会把这些 tgz 离线安装到 DSH 的插件 profile，实现"装完即用"，无需 NAS 联网。
# 条目格式：npm 包名直接打包；@local/<name> 前缀表示从仓库内
# plugins-src/<name>/ 目录打包（私有插件不发 npm，见 plan 决策 C）。
if [ -n "${BUNDLED_DSH_PLUGINS}" ]; then
    echo "==> Bundling DSH plugins for offline seed: ${BUNDLED_DSH_PLUGINS}"
    mkdir -p "${WORK_DIR}/app_root/plugins"
    for PKG in ${BUNDLED_DSH_PLUGINS}; do
        if [[ "${PKG}" == @local/* ]]; then
            # 本地插件源：目录必须存在且含合法 package.json，否则显式失败。
            LOCAL_DIR="${REPO_ROOT}/plugins-src/${PKG#@local/}"
            if [ ! -f "${LOCAL_DIR}/package.json" ]; then
                echo "❌ 本地插件目录不存在或缺少 package.json: ${LOCAL_DIR}" >&2
                exit 1
            fi
            PKG_VER=$(node -p "require('${LOCAL_DIR}/package.json').version" 2>/dev/null || echo "unknown")
            echo "    - Packing local plugin ${PKG#@local/}@${PKG_VER}..."
            if ! "${WORK_DIR}/node/bin/npm" pack "${LOCAL_DIR}" --pack-destination "${WORK_DIR}/app_root/plugins" --silent; then
                echo "❌ 打包本地插件 ${PKG} 失败" >&2
                exit 1
            fi
        else
            # npm 插件源：解析最新版本（仅显示用途；tgz 本身即锁定该版本的快照）
            PKG_VER=$(npm view "${PKG}" version 2>/dev/null || echo "unknown")
            echo "    - Fetching ${PKG}@${PKG_VER}..."
            if ! "${WORK_DIR}/node/bin/npm" pack "${PKG}" --pack-destination "${WORK_DIR}/app_root/plugins" --silent; then
                echo "❌ 预下载插件 ${PKG} 失败" >&2
                exit 1
            fi
        fi
    done
    # 写入清单供 runner.js 校验（记录实际打包的文件名）
    ls "${WORK_DIR}/app_root/plugins"/*.tgz | xargs -n1 basename > "${WORK_DIR}/app_root/plugins/bundled.txt"
fi

# 4. 执行飞牛目录选择与浏览器兼容补丁；不限制提供商或模型目录。
python3 "${SCRIPT_DIR}/patch.py" "${WORK_DIR}/app_root"

# 5. 在打包前校验所有 DeepSeek 模块的 JavaScript 语法，避免把无法启动的包交给 fnOS。
echo "==> Checking patched DeepSeek JavaScript syntax..."
SYNTAX_ERRORS=0
# 目录缺失（npm install 布局异常）必须显式失败，否则 find 零迭代会被误判为校验通过
if [ ! -d "${WORK_DIR}/app_root/node_modules/@deepseek-ai" ]; then
    echo "Refusing to package: ${WORK_DIR}/app_root/node_modules/@deepseek-ai 不存在，npm install 布局异常" >&2
    exit 1
fi
while IFS= read -r JS_FILE; do
    if ! "${WORK_DIR}/node/bin/node" --check "${JS_FILE}" >/dev/null 2>&1; then
        echo "Syntax check failed: ${JS_FILE}" >&2
        SYNTAX_ERRORS=$((SYNTAX_ERRORS + 1))
    fi
done < <(find "${WORK_DIR}/app_root/node_modules/@deepseek-ai" -type f \( -name '*.js' -o -name '*.mjs' \) -print)

if [ "${SYNTAX_ERRORS}" -ne 0 ]; then
    echo "Refusing to package: ${SYNTAX_ERRORS} DeepSeek JavaScript file(s) failed syntax validation." >&2
    exit 1
fi

# 6. Build app.tgz
tar --owner=0 --group=0 --numeric-owner -czf "${OUTPUT_TGZ}" -C "${WORK_DIR}/app_root" .
cp "${OUTPUT_TGZ}" "${REPO_ROOT}/app.tgz" 2>/dev/null || true
echo "==> Built ${OUTPUT_TGZ} for DeepSeek Harness ${VERSION}"
du -h "${OUTPUT_TGZ}"
