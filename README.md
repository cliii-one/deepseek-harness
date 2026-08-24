# DeepSeek Harness for fnOS (飞牛私有云 NAS)

[![Build and Release DeepSeek Harness FPK](https://github.com/cliii-one/deepseek-harness/actions/workflows/build-and-release.yml/badge.svg)](https://github.com/cliii-one/deepseek-harness/actions/workflows/build-and-release.yml)

本项目为 **DeepSeek Harness** 在 **飞牛私有云 NAS (fnOS)** 上的离线安装包（`.fpk`）及自动构建流水线。

---

## ✨ 功能特性

1. **开箱即用**：
   - 支持多模型、多通道及 Web UI 管理
   - 模型、Base URL 和 API Key 均可编辑；可使用多个模型，也可新增自己的提供商
2. **极简安装向导**：
   - 移除多余的端口交互（内置安全固定端口）
3. **工作区与飞牛桌面【文件管理】同步互通**：
   - 应用数据目录直接与飞牛桌面【文件管理】→【应用文件】→【`DeepSeekHarness`】桥接
   - 在应用内创建的工程、项目代码、文件实时可见，支持在线管理与下载
4. **局域网环境支持**：
   - 内置安全上下文 Polyfill 与反向代理支持，适配 HTTP / 局域网非安全上下文环境

---

## 📥 安装方法

1. 前往本项目的 [Releases 页面](https://github.com/cliii-one/deepseek-harness/releases) 下载适合您 NAS 硬件架构的 `.fpk` 安装包：
   - **x86_64 设备**（Intel / AMD CPU）：下载 `*_x86.fpk`
   - **ARM 设备**（Rockchip / Allwinner / 树莓派 / ARM64 CPU）：下载 `*_arm.fpk`
2. 登录飞牛 NAS 桌面，打开 **【应用中心】**。
3. 点击右上角 **【手动安装】**，选择下载的 `.fpk` 文件。
4. 按照向导提示完成安装。
5. 在飞牛桌面点击 **DeepSeek Harness** 图标即可启动使用！

---

## 🛠 开发与测试

- **测试套件**（零依赖，本地与 CI 通用）：`bash tests/run-tests.sh`
- **构建安装包**（需 Linux/macOS，会下载 Node 运行时并执行 npm install）：
  ```bash
  VERSION=<DSH版本> TARBALL_ARCH=amd64 bash scripts/apps/deepseek-harness/build.sh
  bash build-fpk.sh <FPK版本> x86
  ```
- **CI 脚本**位于 `scripts/ci/`，由 `.github/workflows/build-and-release.yml` 调用；版本兜底值等构建元数据统一在 `scripts/apps/deepseek-harness/meta.env` 维护。

---

## 📄 开源许可

本项目遵循 MIT 开源许可证。
