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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-selfupdater';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 要升级的主程序包名。 */
const PKG = '@deepseek-ai/dsh';
/** npm registry 查询超时。 */
const FETCH_TIMEOUT_MS = 15000;
/** 国内 npm 镜像（腾讯云），registry.npmjs.org 直连超时时的第一回退。 */
const NPM_CHINA_MIRROR = 'https://mirrors.cloud.tencent.com/npm';

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

/** 解析工作区目录（与 runner.js 的优先级一致）。 */
function resolveWorkspace(appDir) {
    return resolve(process.env.TRIM_VAR ?? appDir);
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
        const port = servicePort();

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

        host.logger?.info?.('[dsh-selfupdater] 路由已挂载');
    });
}
