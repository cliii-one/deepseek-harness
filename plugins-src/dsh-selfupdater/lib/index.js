/**
 * dsh-selfupdater 宿主入口：注册 HTTP 路由，桥接浏览器设置卡片与升级脚本。
 *
 * 职责边界：本文件只做"读状态 / 查版本 / 触发升级"，真正的
 * 下载-换目录-重启-回滚全部由分离进程 lib/updater.mjs 完成（原因：
 * 要替换的是 DSH 自己脚下的 node_modules，必须先让 DSH 退出）。
 *
 * 安全模型（与 dshmarket lib/http.js 完全一致）：
 * - POST 接口仅接受 same-origin 请求（Origin 与 Host 头一致）；
 * - 升级动作通过锁文件防并发，双端校验。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-selfupdater';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 要升级的主程序包名。 */
const PKG = '@deepseek-ai/dsh';
/** npm registry 查询超时。 */
const FETCH_TIMEOUT_MS = 15000;
/** 国内 npm 镜像（腾讯云），registry.npmjs.org 直连超时时的第一回退。 */
const NPM_CHINA_MIRROR = 'https://mirrors.cloud.tencent.com/npm';
/** 插件所在的 profile 名（与 runner.js 的 DSH_PLUGIN_PROFILE 约定一致）。 */
const PLUGIN_PROFILE = process.env.DSH_PLUGIN_PROFILE ?? 'web';

/* ------------------------------------------------------------------ *
 * semver 比较（零依赖，与 updater.mjs 内实现保持一致）
 * ------------------------------------------------------------------ */

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemver(v) {
    const m = SEMVER_RE.exec(String(v ?? '').trim());
    if (m === null) return null;
    return {
        core: [Number(m[1]), Number(m[2]), Number(m[3])],
        pre: m[4] === undefined ? [] : m[4].split('.'),
    };
}

/** 返回负数/0/正数；任一侧非法返回 null。 */
function compareVersions(a, b) {
    const pa = parseSemver(a);
    const pb = parseSemver(b);
    if (pa === null || pb === null) return null;
    for (let i = 0; i < 3; i++) {
        if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
    }
    if (pa.pre.length === 0 || pb.pre.length === 0) return pb.pre.length - pa.pre.length;
    for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
        const x = pa.pre[i];
        const y = pb.pre[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        if (x === y) continue;
        const nx = /^\d+$/.test(x);
        const ny = /^\d+$/.test(y);
        if (nx && ny) return Number(x) - Number(y);
        if (nx !== ny) return nx ? -1 : 1;
        return x < y ? -1 : 1;
    }
    return 0;
}

function isNewer(latest, installed) {
    const cmp = compareVersions(latest, installed);
    return cmp !== null && cmp > 0;
}

/* ------------------------------------------------------------------ *
 * HTTP 工具（照搬 dshmarket lib/http.js）
 * ------------------------------------------------------------------ */

/** 写 JSON 响应并禁用缓存。 */
function sendJson(response, code, payload) {
    response.writeHead(code, {
        'cache-control': 'no-store',
        'content-type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify(payload));
}

/**
 * 同源校验（与 dshmarket lib/http.js 完全一致）：Origin 的 host 部分必须
 * 与请求头 Host 一致。经 runner.js 透明反代访问时，反代会把 Origin 与 Host
 * 统一改写为 http://127.0.0.1:<DSH_PORT>，两者天然相等，校验照常通过；
 * 直连场景下两者本来就相同。跨站伪造请求的 Origin 是外部地址，会被拒绝。
 */
function sameOrigin(request) {
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (origin === undefined || host === undefined) return false;
    try {
        return new URL(origin).host === host;
    } catch {
        return false;
    }
}

/* ------------------------------------------------------------------ *
 * 状态与路径解析
 * ------------------------------------------------------------------ */

/** 从 --profile 参数读取宿主实际启动的 profile（与 dshmarket 相同的兜底逻辑）。 */
function argvProfile() {
    const argv = process.argv;
    const flag = argv.indexOf('--profile');
    if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1].startsWith('-')) {
        return argv[flag + 1];
    }
    return undefined;
}

/**
 * 定位 DSH 应用目录（node_modules 所在处）。
 * 优先 TRIM_APPDEST 环境变量；否则从本插件安装位置向上找 node_modules 边界。
 */
function resolveAppDir() {
    const envDir = process.env.TRIM_APPDEST;
    if (envDir && existsSync(join(envDir, 'node_modules', PKG))) return resolve(envDir);
    // 插件位于 …/APP_DIR/node_modules/dsh-selfupdater/lib/index.js → 上三级即 APP_DIR。
    const candidate = resolve(PLUGIN_ROOT, '..', '..');
    if (existsSync(join(candidate, 'node_modules', PKG))) return candidate;
    throw new Error(`无法定位 ${PKG} 的应用目录`);
}

/**
 * 解析工作区目录（插件清单 .dsh/profiles 的真正落盘处）。
 * 与 runner.js 的推导链保持一致：
 * 1. TRIM_DATA_SHARE_PATHS 第一个共享目录（飞牛声明的工作区，runner 会优先用它）；
 * 2. HOME 环境变量（runner 启动 DSH 时把 HOME 指到工作区，DSH 的 profile 就在 $HOME/.dsh 下）；
 * 3. TRIM_VAR / appDir/data 兜底（本地开发场景）。
 * 注意：不能只看 TRIM_VAR —— 飞牛部署时它指向 app data 目录而非共享目录，
 * 而 DSH 实际把 profiles 写在 HOME/.dsh 下；此前只读 TRIM_VAR 导致
 * "版本更新"卡片始终显示"未发现已安装插件"。
 */
function resolveWorkspace(appDir) {
    const shares = (process.env.TRIM_DATA_SHARE_PATHS ?? '').split(':').map((s) => s.trim()).filter(Boolean);
    const candidates = [
        ...shares,
        process.env.HOME ?? '',
        process.env.TRIM_VAR ?? '',
        join(appDir, 'data'),
    ].filter((v) => v !== '');
    // 候选目录下若已存在 .dsh 则视为工作区，立即采用；
    // 否则按 runner.js 同样的优先级取第一个候选（与实际落盘位置保持一致）。
    for (const dir of candidates) {
        if (existsSync(join(dir, '.dsh'))) return resolve(dir);
    }
    return resolve(candidates[0] ?? appDir);
}

/** 服务端口：与 runner.js 保持一致的环境变量与默认值。 */
function servicePort() {
    return parseInt(process.env.DSH_PORT ?? '3081', 10);
}

/** 读当前安装的主程序版本。 */
function currentDshVersion(appDir) {
    try {
        return JSON.parse(readFileSync(join(appDir, 'node_modules', PKG, 'package.json'), 'utf8')).version ?? 'unknown';
    } catch {
        return 'unknown';
    }
}

/**
 * 查询 npm registry 最新版本号（带镜像回退，参照 dshmarket regions.ts 的做法）：
 * 1. 优先走环境变量 DSHSU_REGISTRY_URL 指定的镜像（部署方可自行指定国内源）；
 * 2. 默认先试腾讯云国内镜像（飞牛OS 部署多在国内网络，直连 registry.npmjs.org
 *    经常超时——这正是"检查更新没反应"的常见原因）；
 * 3. 镜像失败后回退官方源，保证海外网络也能用。
 */
async function fetchLatestVersion(pkg) {
    const errors = [];
    for (const base of registryCandidates()) {
        try {
            return await fetchFromRegistry(base, pkg);
        } catch (err) {
            errors.push(`${base}: ${err.message}`);
        }
    }
    throw new Error(errors.join('；'));
}

/** 本次要依次尝试的 registry 地址列表（去重）。 */
function registryCandidates() {
    const custom = process.env.DSHSU_REGISTRY_URL?.replace(/\/+$/, '');
    const list = [custom, NPM_CHINA_MIRROR, 'https://registry.npmjs.org'];
    return [...new Set(list.filter((v) => typeof v === 'string' && v !== ''))];
}

/** 从单个 registry 取 latest 版本号。 */
async function fetchFromRegistry(base, pkg) {
    const res = await fetch(`${base}/${encodeURIComponent(pkg)}`, {
        headers: { accept: 'application/json', 'user-agent': 'dsh-selfupdater' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    const latest = doc?.['dist-tags']?.latest;
    if (typeof latest !== 'string' || latest === '') throw new Error('未返回 latest');
    return latest;
}
/** 读升级状态文件（不存在时返回空对象）。 */
function readStatus(dshStateDir) {
    try {
        return JSON.parse(readFileSync(join(dshStateDir, 'selfupdate-status.json'), 'utf8'));
    } catch {
        return {};
    }
}

/**
 * 持久化升级状态文件。
 * 关键修复：首次使用时 .dsh 目录可能尚不存在（只有跑过一次升级脚本才会建它），
 * writeFileSync 会直接抛 ENOENT，导致检查结果从未落盘 —— 这正是 UI 上
 * "最新版本一直显示 —、上次检查一直是从未"的根因；这里先确保目录存在。
 * 写失败仅记录日志不抛出，不能让状态落盘问题阻断接口应答。
 */
function writeStatus(dshStateDir, payload) {
    try {
        mkdirSync(dshStateDir, { recursive: true });
        writeFileSync(join(dshStateDir, 'selfupdate-status.json'), JSON.stringify(payload, null, 2));
    } catch (err) {
        console.warn(`[dsh-selfupdater] 状态文件写入失败: ${err.message}`);
    }
}

/* ------------------------------------------------------------------ *
 * 插件更新（与主程序升级共用同一入口，但走独立的状态/锁/升级脚本）
 * ------------------------------------------------------------------ */

/** 读插件状态文件（不存在时返回空对象）。 */
function readPluginStatus(dshStateDir) {
    try {
        return JSON.parse(readFileSync(join(dshStateDir, 'pluginupdate-status.json'), 'utf8'));
    } catch {
        return {};
    }
}

/** 持久化插件状态文件（自动建目录；失败仅告警不阻断应答）。 */
function writePluginStatus(dshStateDir, payload) {
    try {
        mkdirSync(dshStateDir, { recursive: true });
        writeFileSync(join(dshStateDir, 'pluginupdate-status.json'), JSON.stringify(payload, null, 2));
    } catch (err) {
        console.warn(`[dsh-selfupdater] 插件状态文件写入失败: ${err.message}`);
    }
}

/**
 * 列出 profile 中已安装的插件及其版本。
 * 数据源是 profile/package.json 的 dependencies 字段 —— dsh plugin add
 * 安装时会把它登记进去，这是最权威的"已装清单"。
 */
function listInstalledPlugins(workspace) {
    const profilePkg = join(workspace, '.dsh', 'profiles', PLUGIN_PROFILE, 'package.json');
    try {
        const deps = JSON.parse(readFileSync(profilePkg, 'utf8')).dependencies ?? {};
        return Object.entries(deps).map(([pkgName, range]) => ({
            name: pkgName,
            installedVersion: String(range).replace(/^[~^]\s*/, '') || String(range),
        }));
    } catch {
        return [];
    }
}

/** 查询 npm 上目标插件的 latest 版本号（复用带镜像回退的实现）。 */
async function fetchPluginLatest(pkgName) {
    return fetchLatestVersion(pkgName);
}

/**
 * 读本插件自身的已装版本：优先 import 自己的 package.json（ESM 顶层 await
 * 不适合这里，改用 createRequire 同步读取），失败时回退硬编码兜底值。
 * 用途：让"检测更新"能覆盖 dsh-selfupdater 自己 —— 此前清单来自 profile
 * 的 dependencies，但"检测自己"语义上不依赖那份清单。
 */
function readOwnVersion() {
    try {
        const require = createRequire(import.meta.url);
        return require('../package.json').version;
    } catch {
        return '0.0.0';
    }
}

/* ------------------------------------------------------------------ *
 * apply 入口
 * ------------------------------------------------------------------ */

/**
 * 与 dshmarket 一致的挂载方式：等待 webServer + loader 服务就绪后注册路由。
 * @param ctx - cordis 宿主上下文
 */
export function apply(ctx) {
    ctx.inject(['webServer', 'loader'], async (hostCtx) => {
        const host = hostCtx;
        const appDir = resolveAppDir();
        const workspace = resolveWorkspace(appDir);
        const dshStateDir = join(workspace, '.dsh');
        const lockFile = join(dshStateDir, 'selfupdate.lock');
        const pluginLockFile = join(dshStateDir, 'pluginupdate.lock');
        const port = servicePort();
        /** 本插件的包名与已装版本（用于"检测自己"的更新能力）。 */
        const SELF_NAME = name;
        const SELF_INSTALLED = readOwnVersion();

        /** 升级是否正在进行（锁文件存在）。 */
        const isBusy = () => existsSync(lockFile);

        /**
         * 注册一个精确匹配的路由（照搬 dshmarket 的挂载方式）。
         * webServer.register({ kind:'exact', path, handler }) 返回反注册函数；
         * method 分发由 handler 自行完成，与 dshmarket 各路由的做法一致。
         */
        function registerRoute(method, path, handler) {
            return host.webServer.register({
                kind: 'exact',
                path,
                handler: async (request, response) => {
                    if (request.method !== method) {
                        response.writeHead(405, { allow: method });
                        response.end();
                        return;
                    }
                    await handler(request, response);
                },
            });
        }

        /* ---------- GET /dsh-selfupdater/status ---------- */
        registerRoute('GET', '/dsh-selfupdater/status', (_req, res) => {
            const status = readStatus(dshStateDir);
            const current = currentDshVersion(appDir);
            sendJson(res, 200, {
                currentVersion: current,
                latestVersion: status.latestVersion ?? null,
                state: isBusy() ? (status.state ?? 'running') : (status.state ?? 'idle'),
                message: status.message ?? null,
                lastCheck: status.updatedAt ?? null,
            });
        });

        /* ---------- POST /dsh-selfupdater/check ---------- */
        registerRoute('POST', '/dsh-selfupdater/check', async (req, res) => {
            if (!sameOrigin(req)) {
                sendJson(res, 403, { error: 'untrusted request' });
                return;
            }
            try {
                const latest = await fetchLatestVersion(PKG);
                const current = currentDshVersion(appDir);
                const updateAvailable = isNewer(latest, current);
                // 检查结果落盘（内部自动建目录），UI 刷新后仍能看到上次检查时间。
                writeStatus(dshStateDir, {
                    ...(await Promise.resolve(readStatus(dshStateDir))),
                    currentVersion: current,
                    latestVersion: latest,
                    state: isBusy() ? 'running' : 'idle',
                    message: updateAvailable ? `发现新版本 ${latest}` : '当前已是最新',
                    updatedAt: new Date().toISOString(),
                });
                sendJson(res, 200, { currentVersion: current, latestVersion: latest, updateAvailable });
            } catch (err) {
                host.logger?.warn?.(`[dsh-selfupdater] 检查更新失败: ${err.message}`);
                // 失败信息也写入状态文件：UI 轮询能看到具体原因，不再"没反应"。
                writeStatus(dshStateDir, {
                    ...readStatus(dshStateDir),
                    state: isBusy() ? 'running' : 'idle',
                    message: `检查更新失败：${err.message}`,
                    updatedAt: new Date().toISOString(),
                });
                sendJson(res, 502, { error: `检查更新失败：${err.message}` });
            }
        });

        /* ---------- POST /dsh-selfupdater/perform ---------- */
        registerRoute('POST', '/dsh-selfupdater/perform', (req, res) => {
            if (!sameOrigin(req)) {
                sendJson(res, 403, { error: 'untrusted request' });
                return;
            }
            // 并发防护：锁文件已存在说明有升级在跑（或上次异常残留未清理）。
            if (isBusy()) {
                sendJson(res, 409, { error: '已有一次升级在进行中' });
                return;
            }
            // 预置锁文件：updater.mjs 启动后会校验它存在才继续。
            try {
                writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now(), by: 'plugin' }));
            } catch (err) {
                sendJson(res, 500, { error: `写入锁文件失败：${err.message}` });
                return;
            }
            const child = spawn(process.execPath, [
                join(PLUGIN_ROOT, 'lib', 'updater.mjs'),
                '--pid', String(process.pid),
                '--app-dir', appDir,
                '--workspace', workspace,
                '--port', String(port),
                '--pkg', PKG,
            ], { detached: true, stdio: 'ignore', env: process.env });
            child.unref();

            host.logger?.info?.(`[dsh-selfupdater] 升级进程已启动 pid=${child.pid}，主程序即将退出`);
            // 给 spawn 一点时间落稳再退出，避免父进程先死导致子进程被会话回收。
            setTimeout(() => process.exit(0), 800);
            // 先应答，让前端拿到"已受理"再等断线。
            sendJson(res, 202, { accepted: true, note: '服务将自动退出并由升级脚本接管' });
        });

        /* ---------- GET /dsh-selfupdater/plugins ---------- */
        /** 插件更新是否正在进行（锁文件存在）。 */
        const pluginBusy = () => existsSync(pluginLockFile);
        /** 读插件状态并合并"服务端视角"的忙闲标记。 */
        const pluginStatusView = () => ({
            ...readPluginStatus(dshStateDir),
            state: pluginBusy() ? (readPluginStatus(dshStateDir).state ?? 'running') : (readPluginStatus(dshStateDir).state ?? 'idle'),
        });

        registerRoute('GET', '/dsh-selfupdater/plugins', (_req, res) => {
            // 清单 = 自己 + profile 已装插件（自己排最前，保证 UI 始终展示自身）。
            const installed = [
                { name: SELF_NAME, installedVersion: SELF_INSTALLED },
                ...listInstalledPlugins(workspace).filter((p) => p.name !== SELF_NAME),
            ];
            const status = pluginStatusView();
            // 把上次检查得到的 latest 缓存合并进列表，UI 无需二次请求。
            const cache = status.updates ?? {};
            const items = installed.map((p) => ({
                ...p,
                latestVersion: cache[p.name]?.latestVersion ?? null,
                updateAvailable: cache[p.name]?.updateAvailable === true,
                checkedAt: cache[p.name]?.checkedAt ?? null,
            }));
            sendJson(res, 200, {
                profile: PLUGIN_PROFILE,
                busy: pluginBusy(),
                state: status.state ?? 'idle',
                message: status.message ?? null,
                updatedAt: status.updatedAt ?? null,
                plugins: items,
            });
        });

        /* ---------- POST /dsh-selfupdater/plugins/check ---------- */
        registerRoute('POST', '/dsh-selfupdater/plugins/check', async (req, res) => {
            if (!sameOrigin(req)) {
                sendJson(res, 403, { error: 'untrusted request' });
                return;
            }
            // 清单 = 自己 + profile 已装插件（与 GET /plugins 保持一致）。
            const installed = [
                { name: SELF_NAME, installedVersion: SELF_INSTALLED },
                ...listInstalledPlugins(workspace).filter((p) => p.name !== SELF_NAME),
            ];
            // 并发查询所有插件（清单已保证至少包含自己，不可能为空）的最新版；
            // 单个失败不拖垮整体。
            const results = await Promise.allSettled(installed.map(async (p) => {
                const latestVersion = await fetchPluginLatest(p.name);
                return {
                    name: p.name,
                    installedVersion: p.installedVersion,
                    latestVersion,
                    updateAvailable: isNewer(latestVersion, p.installedVersion),
                    checkedAt: new Date().toISOString(),
                };
            }));
            const updates = {};
            for (const r of results) {
                if (r.status !== 'fulfilled') continue;
                updates[r.value.name] = {
                    latestVersion: r.value.latestVersion,
                    updateAvailable: r.value.updateAvailable,
                    checkedAt: r.value.checkedAt,
                };
            }
            const failed = results.filter((r) => r.status === 'rejected').length;
            writePluginStatus(dshStateDir, {
                ...readPluginStatus(dshStateDir),
                state: 'idle',
                message: failed > 0 ? `检查完成，${failed} 个插件查询失败（网络原因可重试）` : '检查完成',
                updates,
                updatedAt: new Date().toISOString(),
            });
            sendJson(res, 200, {
                updatedCount: Object.values(updates).filter((u) => u.updateAvailable).length,
                failedCount: failed,
            });
        });

        /* ---------- POST /dsh-selfupdater/plugins/update ---------- */
        registerRoute('POST', '/dsh-selfupdater/plugins/update', (req, res) => {
            if (!sameOrigin(req)) {
                sendJson(res, 403, { error: 'untrusted request' });
                return;
            }
            if (pluginBusy()) {
                sendJson(res, 409, { error: '已有一次插件更新在进行中' });
                return;
            }
            try {
                writePluginStatus(dshStateDir, {
                    ...readPluginStatus(dshStateDir),
                    state: 'running',
                    message: '插件更新已受理，正在启动升级脚本…',
                    startedAt: new Date().toISOString(),
                });
                writeFileSync(pluginLockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now(), by: 'plugin-update' }));
            } catch (err) {
                sendJson(res, 500, { error: `写入锁文件失败：${err.message}` });
                return;
            }
            const child = spawn(process.execPath, [
                join(PLUGIN_ROOT, 'lib', 'plugin-updater.mjs'),
                '--pid', String(process.pid),
                '--app-dir', appDir,
                '--workspace', workspace,
                '--port', String(port),
            ], { detached: true, stdio: 'ignore', env: process.env });
            child.unref();

            host.logger?.info?.(`[dsh-selfupdater] 插件更新进程已启动 pid=${child.pid}，DSH 即将退出`);
            // 与主程序升级一致：给 spawn 落稳时间后主动退出，让脚本接管重启链。
            setTimeout(() => process.exit(0), 800);
            sendJson(res, 202, { accepted: true, note: '插件更新将由分离脚本执行并自动重启服务' });
        });

        host.logger?.info?.('[dsh-selfupdater] 路由已挂载');
    });
}
