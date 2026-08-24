# DeepSeek Harness · 飞牛NAS版

<p align="center">
  <img src="deepseek-harness/ICON_256.PNG" width="128" alt="DeepSeek Harness Icon">
</p>

<p align="center">
  <strong>AI开发助手与桌面工作台 · 飞牛NAS原生应用</strong>
</p>

<p align="center">
  <a href="https://github.com/cliii-one/deepseek-harness/releases">
    <img src="https://img.shields.io/github/v/release/cliii-one/deepseek-harness?style=flat-square" alt="Release">
  </a>
  <a href="https://github.com/cliii-one/deepseek-harness/actions">
    <img src="https://img.shields.io/github/actions/workflow/status/cliii-one/deepseek-harness/build.yml?style=flat-square" alt="Build">
  </a>
</p>

---

## ✨ 功能特性

- 🤖 **多模型支持** — 接入DeepSeek官方API，支持多种AI模型
- 🖥️ **Web UI管理** — 浏览器访问，直观的对话与工作台界面
- 📁 **文件互通** — 与飞牛桌面文件管理实时同步
- 🌐 **局域网访问** — 内置反向代理，完美支持局域网环境
- 🔒 **安全隔离** — 专用应用用户运行，数据安全可控
- 📦 **一键安装** — 标准FPK包，飞牛应用中心直接安装

## 📥 安装方式

### 方式一：手动安装（推荐）

1. 前往 [Releases](https://github.com/cliii-one/deepseek-harness/releases) 下载最新版本
2. 登录飞牛NAS桌面 → 打开 **应用中心**
3. 点击右上角 **手动安装** → 选择下载的 `.fpk` 文件
4. 按向导提示完成安装

### 方式二：从源码构建

```bash
# 克隆仓库
git clone https://github.com/cliii-one/deepseek-harness.git
cd deepseek-harness

# 构建应用包（需要Node.js环境）
bash scripts/build.sh

# 打包FPK安装包
bash build-fpk.sh
```

## 🏗️ 项目结构

```
deepseek-harness/
├── .github/workflows/        # GitHub Actions自动构建
│   └── build.yml
├── deepseek-harness/         # 飞牛应用包（FPK标准结构）
│   ├── manifest              # 应用元数据
│   ├── cmd/                  # 生命周期脚本
│   ├── config/               # 权限与资源声明
│   ├── wizard/               # 安装向导
│   └── app/                  # 应用运行文件
├── scripts/                  # 构建脚本
│   ├── build.sh              # 应用包构建
│   ├── patch.py              # 兼容性补丁
│   └── meta.env              # 版本元数据
└── build-fpk.sh              # FPK打包脚本
```

## 🔧 技术架构

```
┌─────────────────────────────────────────────────────────┐
│                    飞牛NAS桌面                           │
│  ┌───────────────────────────────────────────────────┐  │
│  │            DeepSeek Harness (iframe)              │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│  runner.js (0.0.0.0:3080)                              │
│  ├── 反向代理 → 127.0.0.1:3081                         │
│  ├── Polyfill注入 (crypto.randomUUID等)                │
│  └── 进程生命周期管理                                    │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│  DeepSeek Harness (127.0.0.1:3081)                     │
│  ├── Web UI服务                                         │
│  ├── API接口                                             │
│  └── 多模型管理                                          │
└─────────────────────────────────────────────────────────┘
```

## 📋 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `TRIM_APPDEST` | 应用安装目录 | 系统自动设置 |
| `TRIM_PKGVAR` | 运行数据目录 | 系统自动设置 |
| `TRIM_SERVICE_PORT` | 服务端口 | 3080 |

## 🛠️ 开发指南

### 本地开发

```bash
# 安装依赖
npm install

# 运行测试
npm test

# 构建应用包
bash scripts/build.sh
```

### 构建选项

```bash
# 指定DSH版本
VERSION=0.1.1-rc.3 bash scripts/build.sh

# 指定架构
TARBALL_ARCH=arm64 bash scripts/build.sh

# 打包指定平台
bash build-fpk.sh 0.1.1-rc.3 arm
```

## 📄 许可证

MIT License

## 🙏 致谢

- [DeepSeek](https://github.com/deepseek-ai) — 提供DeepSeek Harness核心框架
- [飞牛NAS](https://www.fnnas.com/) — 提供应用开发平台
