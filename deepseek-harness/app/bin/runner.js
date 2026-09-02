/**
 * DeepSeek Harness - fnOS 统一运行器 (Runner)
 * 1. 负责启动上游 dsh web (127.0.0.1:3081)
 * 2. 负责启动局域网透明反向代理 (0.0.0.0:3080 -> 127.0.0.1:3081)
 * 3. 自动注入 crypto.randomUUID Polyfill (解决非安全上下文局域网浏览器报错)
 * 4. 精确进程生命周期管理，响应 SIGTERM/SIGINT 秒级退出
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const readline = require('readline');

const APP_DIR = process.env.TRIM_APPDEST || path.resolve(__dirname, '..');
const VAR_DIR = process.env.TRIM_PKGVAR || path.join(APP_DIR, 'data');
const NODE_BIN = path.join(APP_DIR, 'bin', 'node');
const DSH_BIN = path.join(APP_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');

const PROXY_PORT = parseInt(process.env.PORT || '3080', 10);
const DSH_PORT = parseInt(process.env.DSH_PORT || '3081', 10);

// DSH 的可编辑设置、凭据和插件 profile 都由 HOME 下的 .dsh 管理。
// 先确定飞牛工作区，才能在启动前安全迁移旧配置。
let WORKSPACE_DIR = VAR_DIR;
// 优先使用飞牛声明的数据共享目录
const TRIM_SHARES = process.env.TRIM_DATA_SHARE_PATHS || '';
if (TRIM_SHARES) {
    const firstShare = TRIM_SHARES.split(':')[0];
    if (firstShare && fs.existsSync(firstShare)) {
        WORKSPACE_DIR = firstShare;
    }
}

// 确保 umask 为 0，使 DSH 创建的文件与目录对宿主机 NAS 用户及 SMB 保持完全可读写
try {
    process.umask(0);
} catch (e) {}

function ensureWorkspacePermissions() {
    const wsDir = path.join(WORKSPACE_DIR, 'workspace');
    try {
        if (!fs.existsSync(wsDir)) {
            fs.mkdirSync(wsDir, { recursive: true, mode: 0o777 });
        } else {
            fs.chmodSync(wsDir, 0o777);
        }
    } catch (e) {}
}
ensureWorkspacePermissions();

// 读取向导配置变量 (wizard_variables)
const dshEnv = { ...process.env };
const wizardVarsFile = path.join(VAR_DIR, 'wizard_variables');
if (fs.existsSync(wizardVarsFile)) {
    try {
        const content = fs.readFileSync(wizardVarsFile, 'utf-8');
        const lines = content.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx !== -1) {
                const key = trimmed.slice(0, eqIdx).trim();
                let val = trimmed.slice(eqIdx + 1).trim();
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                dshEnv[key] = val;
            }
        }
    } catch (e) {
        console.warn('[Runner] 读取向导变量失败:', e);
    }
}

// 如果用户配置了 DEEPSEEK_BASE_URL 环境变量，传递给 DSH
// 否则由用户在 DSH 的 Models 页面自行配置

// 修复 "duplicate catalog model" 导致的 boot 失败（症状：UI 里所有会话消失）。
// dsh-llm-deepseek 的内置 catalog 已含 deepseek-v4-flash / deepseek-v4-pro，
// 若 settings.yaml 的 llm-deepseek.models 也写入了同名 id，启动时模型条目重复，
// 插件树加载失败 -> dsh 直接退出 -> 会话列表为空。这里把用户配置中与内置
// catalog 重复的条目剔除，保留新增的自定义模型。
function dedupeCatalogModels() {
    const settingsFile = path.join(WORKSPACE_DIR, '.dsh', 'settings.yaml');
    try {
        if (!fs.existsSync(settingsFile)) return false;
        let content = fs.readFileSync(settingsFile, 'utf-8');
        const builtinIds = ['deepseek-v4-flash', 'deepseek-v4-pro'];
        const lines = content.split('\n');
        let out = [];
        let inModels = false;
        let changed = false;
        let skipTillBlank = false; // 跳过当前被剔除条目的后续属性行，直到下一个 '- id:' 或顶层键
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (/^\s{0,2}llm-deepseek:\s*$/.test(line)) {
                out.push(line);
                inModels = false;
                skipTillBlank = false;
                continue;
            }
            const isTopKey = /^\s{0,2}[a-zA-Z0-9_-]+:\s*$/.test(line);
            if (isTopKey) {
                inModels = /^\s{0,2}models:\s*$/.test(line);
                skipTillBlank = false;
                out.push(line);
                continue;
            }
            if (/^\s+-\s+id:\s*['"]?([a-zA-Z0-9_.-]+)['"]?\s*$/.test(line)) {
                const id = line.match(/^\s+-\s+id:\s*['"]?([a-zA-Z0-9_.-]+)['"]?\s*$/)[1];
                if (inModels && builtinIds.includes(id)) {
                    changed = true;
                    skipTillBlank = true;
                    continue;
                }
                skipTillBlank = false;
                out.push(line);
                continue;
            }
            if (skipTillBlank) continue; // 跳过被剔除条目的 name/contextWindow 等属性行
            out.push(line);
        }
        if (changed) {
            // 若剔除后 models 列表为空，直接删除整个 models 键（空列表会导致
            // dsh 无模型可选；删除后 dsh 回落到内置目录）。
            const cleaned = out.join('\n').replace(/\n?\s{2}models:\s*(?=\n[a-zA-Z0-9_-]+:|\s*$)/, '');
            fs.writeFileSync(settingsFile, cleaned, 'utf-8');
            return true;
        }
    } catch (e) {
        console.warn('[Runner] 去重内置模型配置失败:', e.message);
    }
    return false;
}

const catalogDeduped = dedupeCatalogModels();

// ===================== 内置插件离线安装 =====================
// 构建期已把插件 tgz 打包到 ${APP_DIR}/plugins（bundled.txt 记录清单）。
// 首次启动时同步种子到工作区并调用 `dsh plugin add` 离线安装；
// 安装成功后写 .dsh/bundled_plugins_done 标记，后续启动直接跳过。
const PLUGINS_SEED_DIR = path.join(APP_DIR, 'plugins');
const PLUGIN_MARKER_FILE = path.join(WORKSPACE_DIR, '.dsh', 'bundled_plugins_done');
const DSH_PLUGIN_PROFILE = process.env.DSH_PLUGIN_PROFILE || 'web';

/**
 * 读取内置插件清单（bundled.txt，每行一个 tgz 文件名）
 * @returns {string[]} tgz 文件名列表；无内置插件时返回空数组
 */
function readBundledPluginList() {
    const listFile = path.join(PLUGINS_SEED_DIR, 'bundled.txt');
    try {
        if (!fs.existsSync(listFile)) return [];
        return fs.readFileSync(listFile, 'utf-8')
            .split('\n')
            .map((s) => s.trim())
            .filter((s) => s.endsWith('.tgz'));
    } catch (e) {
        return [];
    }
}

/**
 * 读取指定插件当前安装的版本号（0.4.12 修正为以实际落盘为准）
 * 优先读 profile/node_modules 里插件自身的 package.json（权威：
 * FPK 安装会把清单声明写成 file:/…tgz 而非版本号，且在线更新装好
 * 未重启时只有这里是新版本号）；读不到再回退清单 dependencies 声明。
 * @param {string} profileDir 插件 profile 目录
 * @param {string} pkgName 插件包名（如 dshmarket）
 * @returns {string|null} 已安装版本号；查不到返回 null
 */
function getInstalledPluginVersion(profileDir, pkgName) {
    try {
        const installedPkg = path.join(profileDir, 'node_modules', pkgName, 'package.json');
        if (fs.existsSync(installedPkg)) {
            const ver = JSON.parse(fs.readFileSync(installedPkg, 'utf-8')).version;
            if (ver) return String(ver);
        }
        const pkgJsonPath = path.join(profileDir, 'package.json');
        if (fs.existsSync(pkgJsonPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
            const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
            for (const [name, ver] of Object.entries(deps)) {
                // 兼容 scoped 包名（@a/b）与非 scoped 名的匹配
                if (name === pkgName || name.endsWith(`/${pkgName}`)) return ver;
            }
        }
    } catch (e) {}
    return null;
}

/**
 * 从 tgz 文件名解析包名与版本号：dshmarket-1.29.2.tgz -> { name: 'dshmarket', version: '1.29.2' }
 * 注意：scoped 包名形如 scope-name-pkg-1.0.0，无法从文件名精确还原 @scope/pkg，
 * 这里仅做非严格解析，供版本比对参考
 */
function parseTgzName(tgzName) {
    const base = tgzName.replace(/\.tgz$/, '');
    const m = base.match(/^(.+?)-(\d+\.\d+\.[\w.-]*)$/);
    if (!m) return { name: base, version: null };
    return { name: m[1], version: m[2] };
}

/**
 * 同步构建期插件种子到工作区（升级后新版本 tgz 覆盖旧种子）
 */
function syncPluginSeeds() {
    try {
        if (!fs.existsSync(PLUGINS_SEED_DIR)) return;
        const target = path.join(WORKSPACE_DIR, '.dsh', 'plugin_seed');
        fs.mkdirSync(target, { recursive: true, mode: 0o755 });
        for (const f of [...readBundledPluginList(), 'bundled.txt']) {
            const src = path.join(PLUGINS_SEED_DIR, f);
            if (fs.existsSync(src)) {
                fs.copyFileSync(src, path.join(target, f));
            }
        }
    } catch (e) {
        console.warn('[Runner] 同步插件种子失败:', e.message);
    }
}

/**
 * 简易 semver 数字段比较（x.y.z）：a>b 返回 1，a<b 返回 -1，不可解析返回 null。
 * 种子与已装版本均为纯 semver，无需完整 semver 规范实现。
 */
function compareSimpleSemver(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    if (pa.some(Number.isNaN) || pb.some(Number.isNaN) || pa.length < 3 || pb.length < 3) return null;
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
    }
    return 0;
}

/**
 * 首次启动把内置插件离线装入 DSH profile（同步执行，阻塞在 dsh 启动前）。
 * 升级场景：应用升级后种子里的 tgz 版本比 profile 已装版本新时自动重装。
 */
function installBundledPlugins() {
    const plugins = readBundledPluginList();
    if (!plugins.length) return; // 无内置插件，跳过

    const seedDir = path.join(WORKSPACE_DIR, '.dsh', 'plugin_seed');
    const profileDir = path.join(WORKSPACE_DIR, '.dsh', 'profiles', DSH_PLUGIN_PROFILE);
    fs.mkdirSync(profileDir, { recursive: true, mode: 0o777 });

    let allOk = true;
    for (const tgz of plugins) {
        const { name: pkgName, version: seedVer } = parseTgzName(tgz);
        const installedVer = getInstalledPluginVersion(profileDir, pkgName);
        // 幂等规则（0.4.12 修正）：种子版本不高于已装版本就跳过。
        // - 相等：内容一致，无需重装；
        // - 种子更旧：说明插件已在线自我更新到更高版本，绝不能用 FPK 旧种子
        //   降级重装 —— 旧规则"仅相等才跳过"正是"在线更新成功但重启后版本
        //   回退"的根因；
        // - 种子更新（FPK 应用升级带来新版）：正常重装。
        const cmp = compareSimpleSemver(seedVer, installedVer);
        if (installedVer && seedVer && cmp !== null && cmp <= 0) {
            // 跳过决策留痕：便于排查"插件版本被回退"类问题（回退到底发生在
            // runner 重装还是 pnpm 依赖重算，一看日志便知）。
            console.log(`[Runner] 插件 ${pkgName}: 已装 ${installedVer} >= 种子 ${seedVer}，跳过内置安装`);
            continue;
        }
        console.log(`[Runner] 正在内置安装插件: ${tgz}${installedVer ? `（当前 ${installedVer} -> 目标 ${seedVer ?? 'unknown'}）` : ''} -> profile "${DSH_PLUGIN_PROFILE}"...`);
        // dsh plugin add <tgz>：与手动执行 `dsh plugin --profile web add xxx` 等价
        const r = spawnSync(NODE_BIN, [DSH_BIN, 'plugin', '--profile', DSH_PLUGIN_PROFILE, 'add', path.join(seedDir, tgz)], {
            cwd: WORKSPACE_DIR,
            env: { ...process.env, PATH: `${path.join(APP_DIR, 'bin')}:${process.env.PATH}`, HOME: WORKSPACE_DIR },
            stdio: 'inherit'
        });
        if (r.status !== 0) {
            console.warn(`[Runner] 插件 ${tgz} 内置安装失败（不影响启动，可稍后在插件市场手动安装）`);
            allOk = false;
        }
    }

    // 记录本轮处理完成的版本清单，便于排查与观测
    if (allOk) {
        try {
            fs.writeFileSync(PLUGIN_MARKER_FILE, `${new Date().toISOString()} plugins=${plugins.join(',')}`, 'utf-8');
            console.log('[Runner] 内置插件检查/安装完成');
        } catch (e) {}
    }
}

// 内置插件安装属于"锦上添花"：任何异常都不能阻断 dsh 主服务启动
try {
    syncPluginSeeds();
    installBundledPlugins();
} catch (e) {
    console.warn('[Runner] 内置插件流程异常（不影响启动）:', e.message);
}

// 强力 Polyfill 脚本：全面覆盖 window, self, globalThis, Crypto.prototype 以及 AbortSignal.any / AbortSignal.timeout
const POLYFILL_SCRIPT = `<script>
(function() {
  function createUUID() {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, function(c) {
        return (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16);
      });
    }
    return '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, function(c) {
      return (c ^ (Math.floor(Math.random() * 256)) & (15 >> (c / 4))).toString(16);
    });
  }

  try {
    var g = typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : this;
    if (typeof window !== 'undefined') {
      window.__DSH_LOCAL_APP__ = true;
    }
    
    // 1. AbortSignal.any Polyfill (解决华为平板/安卓老旧浏览器/微信WebView "AbortSignal.any is not a function")
    if (typeof g.AbortSignal !== 'undefined' && !g.AbortSignal.any) {
      g.AbortSignal.any = function(signals) {
        var controller = new AbortController();
        if (!signals || !signals.length) return controller.signal;
        for (var i = 0; i < signals.length; i++) {
          var s = signals[i];
          if (!s) continue;
          if (s.aborted) {
            controller.abort(s.reason);
            return controller.signal;
          }
          s.addEventListener('abort', function() {
            controller.abort(this.reason);
          }, { once: true });
        }
        return controller.signal;
      };
    }

    // 2. AbortSignal.timeout Polyfill
    if (typeof g.AbortSignal !== 'undefined' && !g.AbortSignal.timeout) {
      g.AbortSignal.timeout = function(ms) {
        var controller = new AbortController();
        setTimeout(function() {
          var err = new Error('The operation timed out');
          err.name = 'TimeoutError';
          controller.abort(err);
        }, ms);
        return controller.signal;
      };
    }

    // 3. crypto.randomUUID Polyfill (解决局域网非安全上下文)
    if (!g.crypto) {
      try { g.crypto = {}; } catch(e){}
    }
    if (g.crypto) {
      try {
        if (!g.crypto.randomUUID) {
          Object.defineProperty(g.crypto, 'randomUUID', {
            value: createUUID,
            writable: true,
            configurable: true,
            enumerable: true
          });
        }
      } catch (e) {
        g.crypto.randomUUID = createUUID;
      }
    }
    if (typeof Crypto !== 'undefined' && Crypto.prototype && !Crypto.prototype.randomUUID) {
      try {
        Object.defineProperty(Crypto.prototype, 'randomUUID', {
          value: createUUID,
          writable: true,
          configurable: true,
          enumerable: true
        });
      } catch (e) {}
    }

    // 4. Promise.withResolvers Polyfill
    if (typeof Promise !== 'undefined' && !Promise.withResolvers) {
      Promise.withResolvers = function() {
        var resolve, reject;
        var promise = new Promise(function(res, rej) {
          resolve = res;
          reject = rej;
        });
        return { promise: promise, resolve: resolve, reject: reject };
      };
    }
  } catch (e) {
    console.warn('[DSH Polyfill] 初始化异常:', e);
  }
})();
</script>`;

console.log(`[Runner] 正在启动 DeepSeek Harness 后台服务 (127.0.0.1:${DSH_PORT})...`);
if (catalogDeduped) console.log('[Runner] 已剔除 llm-deepseek 配置中与内置目录重复的模型条目');

const dshProcess = spawn(NODE_BIN, [DSH_BIN, 'web', '--host', '127.0.0.1', '--port', String(DSH_PORT)], {
    cwd: WORKSPACE_DIR,
    env: {
        ...dshEnv,
        PATH: `${path.join(APP_DIR, 'bin')}:${process.env.PATH}`,
        HOME: WORKSPACE_DIR
    },
    // stdout 改为管道：需要捕获 dsh 打印的 URL 提取 token（见下方 token 注入说明），
    // 逐行回显保持日志行为与 inherit 一致
    stdio: ['ignore', 'pipe', 'inherit']
});

// token 捕获与注入（适配新版 DSH 的 Web 端点鉴权）：
// 新版 dsh 每次启动随机生成 token，未携带 token 访问 Web 端点一律 401。
// runner 从 dsh stdout 的 "dsh web: http://.../?token=xxx" 行提取 token，
// 由透明代理自动附加到所有转发请求 —— 局域网用户直接访问 3080 端口即可，
// 无需手工拼接 URL（方案2：以 3080 可达即视为可信，豁免 token）。
let webToken = null;
readline.createInterface({ input: dshProcess.stdout }).on('line', (line) => {
    console.log(line);
    if (webToken) return;
    const m = line.match(/[?&]token=([A-Za-z0-9._~-]+)/);
    if (m) {
        webToken = m[1];
        console.log('[Runner] 已捕获 Web token，透明代理将自动携带（访问 3080 无需手动拼接）');
    }
});

dshProcess.on('exit', (code, signal) => {
    console.log(`[Runner] dsh 进程退出，退出码: ${code}, 信号: ${signal}`);
    process.exit(code || 0);
});

// 创建透明反代服务 (0.0.0.0:3080)
const proxyServer = http.createServer((clientReq, clientRes) => {
    const headers = {
        ...clientReq.headers,
        'x-forwarded-for': clientReq.socket.remoteAddress,
        'x-forwarded-proto': 'http',
        'x-forwarded-host': clientReq.headers.host || `0.0.0.0:${PROXY_PORT}`,
        host: `127.0.0.1:${DSH_PORT}`
    };

    // 核心修复：对齐 Origin 与 Referer 避免触发 dsh 上游后端的 CSRF/Host 403 拦截
    if (clientReq.headers.origin) {
        headers.origin = `http://127.0.0.1:${DSH_PORT}`;
    }
    if (clientReq.headers.referer) {
        headers.referer = `http://127.0.0.1:${DSH_PORT}/`;
    }
    if (headers['sec-fetch-site'] === 'cross-site') {
        headers['sec-fetch-site'] = 'same-origin';
    }

    const isHtmlPath = clientReq.url === '/' || clientReq.url.endsWith('.html') || !clientReq.url.includes('.');
    if (isHtmlPath) {
        delete headers['accept-encoding'];
    }

    // 自动携带 token：转发路径未包含 token 时追加（token 由上方 stdout 捕获），
    // 用户已带 token 的请求原样透传，避免重复参数
    let forwardPath = clientReq.url;
    if (webToken && !/[?&]token=/.test(forwardPath)) {
        forwardPath += (forwardPath.includes('?') ? '&' : '?') + `token=${webToken}`;
    }

    const options = {
        hostname: '127.0.0.1',
        port: DSH_PORT,
        path: forwardPath,
        method: clientReq.method,
        headers
    };

    const proxyReq = http.request(options, (proxyRes) => {
        const contentType = proxyRes.headers['content-type'] || '';
        const isHtml = contentType.includes('text/html');

        if (isHtml) {
            let chunks = [];
            let total = 0;
            let overflow = false;
            // 超大响应不再缓冲注入，直接透传，避免内存放大
            const MAX_HTML_BUFFER = 8 * 1024 * 1024;
            proxyRes.on('data', chunk => {
                total += chunk.length;
                if (total > MAX_HTML_BUFFER) {
                    overflow = true;
                    if (!clientRes.headersSent) {
                        clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
                    }
                    clientRes.write(chunk);
                    return;
                }
                chunks.push(chunk);
            });
            proxyRes.on('end', () => {
                if (overflow) {
                    clientRes.end();
                    return;
                }
                let body = Buffer.concat(chunks).toString('utf-8');
                if (body.includes('<head>')) {
                    body = body.replace('<head>', `<head>${POLYFILL_SCRIPT}`);
                } else if (body.includes('<!DOCTYPE html>')) {
                    body = body.replace('<!DOCTYPE html>', `<!DOCTYPE html>${POLYFILL_SCRIPT}`);
                } else {
                    body = POLYFILL_SCRIPT + body;
                }

                const resHeaders = { ...proxyRes.headers };
                delete resHeaders['content-length'];
                resHeaders['content-length'] = Buffer.byteLength(body, 'utf-8');
                // HTML 禁止缓存，确保每次获取最新页面
                resHeaders['cache-control'] = 'no-store, no-cache, must-revalidate';
                resHeaders['pragma'] = 'no-cache';

                clientRes.writeHead(proxyRes.statusCode, resHeaders);
                clientRes.end(body);
            });
        } else {
            // JS/CSS 等带内容哈希的静态资源放行缓存，减少局域网重复回源
            clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(clientRes, { end: true });
        }
    });

    proxyReq.on('error', (err) => {
        if (!clientRes.headersSent) {
            clientRes.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
            clientRes.end('<h3>DeepSeek Harness 正在启动中，请稍候刷新...</h3>');
        }
    });

    clientReq.pipe(proxyReq, { end: true });
});

// 支持 WebSocket / HTTP Upgrade
proxyServer.on('upgrade', (req, socket, head) => {
    const headers = { ...req.headers };
    headers.host = `127.0.0.1:${DSH_PORT}`;
    if (headers.origin) {
        headers.origin = `http://127.0.0.1:${DSH_PORT}`;
    }
    if (headers['sec-fetch-site'] === 'cross-site') {
        headers['sec-fetch-site'] = 'same-origin';
    }

    // WebSocket 升级请求同样自动携带 token（与 HTTP 代理保持一致）
    let upgradePath = req.url;
    if (webToken && !/[?&]token=/.test(upgradePath)) {
        upgradePath += (upgradePath.includes('?') ? '&' : '?') + `token=${webToken}`;
    }

    const proxySocket = net.connect(DSH_PORT, '127.0.0.1', () => {
        proxySocket.write(
            `${req.method} ${upgradePath} HTTP/${req.httpVersion}\r\n` +
            Object.entries(headers)
                .map(([k, v]) => `${k}: ${v}`)
                .join('\r\n') +
            '\r\n\r\n'
        );
        if (head && head.length) proxySocket.write(head);
        socket.pipe(proxySocket);
        proxySocket.pipe(socket);
    });

    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
});

// 端口被占用等监听失败必须给出可诊断的输出，而非未捕获异常裸退
proxyServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[Runner] 端口 ${PROXY_PORT} 已被占用，请检查是否有残留实例（netstat -tlnp | grep :${PROXY_PORT}）`);
    } else {
        console.error(`[Runner] 代理监听失败 (${err.code || 'unknown'}):`, err.message);
    }
    try {
        if (dshProcess && !dshProcess.killed) dshProcess.kill('SIGKILL');
    } catch (e) {
        console.error('[Runner] 终止 dsh 子进程失败:', e.message);
    }
    process.exit(1);
});

proxyServer.listen(PROXY_PORT, '0.0.0.0', () => {
    console.log(`[Runner] 透明代理已启动: http://0.0.0.0:${PROXY_PORT} -> http://127.0.0.1:${DSH_PORT}`);
});

// 优雅退出：先 TERM 让 dsh 落盘会话/索引，宽限期后强制终止
let shuttingDown = false;
function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('[Runner] 收到停止信号，正在停止服务...');
    try {
        proxyServer.close();
    } catch (e) {
        console.error('[Runner] 关闭代理服务失败:', e.message);
    }
    if (dshProcess && !dshProcess.killed) {
        dshProcess.kill('SIGTERM');
        const grace = setTimeout(() => {
            try {
                if (!dshProcess.killed) dshProcess.kill('SIGKILL');
            } catch (e) {
                console.error('[Runner] 强制终止 dsh 子进程失败:', e.message);
            }
            process.exit(0);
        }, 5000);
        grace.unref();
    } else {
        process.exit(0);
    }
    // dsh 正常退出后由 exit 处理器负责退出进程
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGHUP', shutdown);
