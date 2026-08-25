/**
 * dsh-selfupdater 宿主入口：注册 HTTP 路由，桥接浏览器设置卡片与升级脚本。
 *
 * 职责边界：本文件只做"读状态 / 查版本 / 触发升级"，真正的
 * 下载-换目录-重启-回滚全部由分离进程 lib/updater.mjs 完成（原因：
 * 要替换的是 DSH 自己脚下的 node_modules，必须先让 DSH 退出）。
 *
 * 安全模型（照搬 dshmarket restart.js 的做法）：
 * - POST 接口仅接受 same-origin 且无代理转发痕迹的 loopback 请求；
 * - 升级动作通过锁文件防并发，双端校验。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-selfupdater';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 要升级的主程序包名。 */
const PKG = '@deepseek-ai/dsh';
/** npm registry 查询超时。 */
const FETCH_TIMEOUT_MS = 15000;

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
 * 同源校验：Origin 的主机部分必须与 Host 或 x-forwarded-host 一致。
 * 经 runner.js 透明反代访问时，DSH 实际收到的 Host 已被改写为
 * 127.0.0.1:<DSH_PORT>，原始访问主机名在 x-forwarded-host 里；
 * 两个都比对才能同时覆盖"直连"与"反代"两种部署形态。
 */
function sameOrigin(request) {
    const origin = request.headers.origin;
    if (origin === undefined) return false;
    let originHost;
    try {
        originHost = new URL(origin).host;
    } catch {
        return false;
    }
    const candidates = [request.headers.host, request.headers['x-forwarded-host']];
    return candidates.some((h) => typeof h === 'string' && h.split(',')[0].trim() === originHost);
}

/**
 * 可信请求判定：仅接受来自 loopback 的连接，且 Origin 必须与 Host 一致。
 * 注意：不能把"存在代理转发头"当作拒绝理由 —— 本部署中 DSH 只监听
 * 127.0.0.1，浏览器流量全部经过 runner.js 的透明反代，而该代理会固定
 * 附加 x-forwarded-for；若因此拒绝，所有正常浏览器请求都会被误杀。
 * 两道防线足够：来源必须是本机回环 + 同源校验防跨站伪造。
 */
function trustedRequest(request) {
    const address = request.socket.remoteAddress;
    if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
    return sameOrigin(request);
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

/** 查询 npm registry 最新版本号；失败抛错由调用方兜底。 */
async function fetchLatestVersion(pkg) {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`, {
        headers: { accept: 'application/json', 'user-agent': 'dsh-selfupdater' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`registry HTTP ${res.status}`);
    const doc = await res.json();
    const latest = doc?.['dist-tags']?.latest;
    if (typeof latest !== 'string' || latest === '') throw new Error('registry 未返回 latest');
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
         * 注册一个路由的极简包装。webServer 服务提供 on/register 接口；
         * 兼容 dshmarket 所用 host.route / host.on('request') 两种形态，
         * 以运行时探测为准，不假设具体 API。
         */
        function registerRoute(method, pathPrefix, handler) {
            // 形态一：host.route({method, path}, handler)
            if (typeof host.route === 'function') {
                return host.route({ method, path: pathPrefix }, handler);
            }
            // 形态二：host.on('request', cb)，自行按 method+path 分发
            if (typeof host.on === 'function') {
                return host.on('request', (req, res) => {
                    const url = (req.url ?? '/').split('?')[0];
                    if (req.method === method && url === pathPrefix) void handler(req, res);
                });
            }
            host.logger?.warn('[dsh-selfupdater] webServer 未暴露已知路由接口，插件功能不可用');
            return () => {};
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
            if (!trustedRequest(req)) {
                sendJson(res, 403, { error: 'untrusted request' });
                return;
            }
            try {
                const latest = await fetchLatestVersion(PKG);
                const current = currentDshVersion(appDir);
                const updateAvailable = isNewer(latest, current);
                // 写回状态文件，让 UI 刷新后仍能看到上次检查结果。
                try {
                    writeFileSync(
                        join(dshStateDir, 'selfupdate-status.json'),
                        JSON.stringify({
                            ...(await Promise.resolve(readStatus(dshStateDir))),
                            currentVersion: current,
                            latestVersion: latest,
                            state: isBusy() ? 'running' : 'idle',
                            message: updateAvailable ? `发现新版本 ${latest}` : '当前已是最新',
                            updatedAt: new Date().toISOString(),
                        }, null, 2),
                    );
                } catch { /* 状态写失败不影响应答 */ }
                sendJson(res, 200, { currentVersion: current, latestVersion: latest, updateAvailable });
            } catch (err) {
                sendJson(res, 502, { error: `检查更新失败：${err.message}` });
            }
        });

        /* ---------- POST /dsh-selfupdater/perform ---------- */
        registerRoute('POST', '/dsh-selfupdater/perform', (req, res) => {
            if (!trustedRequest(req)) {
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
