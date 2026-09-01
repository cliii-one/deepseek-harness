/**
 * dsh-selfupdater 宿主入口：注册 HTTP 路由，桥接浏览器设置卡片与升级脚本。
 *
 * 职责边界：
 * - 主程序（@deepseek-ai/dsh）升级：要替换的是 DSH 自己脚下的 node_modules，
 *   必须先让 DSH 退出，因此仍走分离进程 lib/updater.mjs（自杀→接管→复活链路）；
 * - 插件（dsh-selfupdater 自己）更新：v0.4.6 起改为进程内原地安装
 *   （lib/plugin-update-task.mjs），全程不杀宿主、不 rename profile，
 *   完成后提示用户重启生效 —— 参照 dshmarket 的成熟做法，
 *   规避与飞牛OS 守护进程拉起实例的端口竞态。
 *
 * 安全模型（与 dshmarket lib/http.js 完全一致）：
 * - POST 接口仅接受 same-origin 请求（Origin 与 Host 头一致）；
 * - 升级动作通过锁文件防并发，双端校验。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLatestVersion, installedSelfVersion, isNewer, runPluginUpdateTask } from './plugin-update-task.mjs';

export const name = 'dsh-selfupdater';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 要升级的主程序包名。 */
const PKG = '@deepseek-ai/dsh';

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
 * 插件更新（自身一键更新；v0.4.6 起由进程内任务完成，见 plugin-update-task.mjs）
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
        /** 本插件的包名（用于"检测自己"的更新能力）。 */
        const SELF_NAME = name;
        /**
         * 已安装的自身版本：每次请求实时读 profile 清单（而非模块加载时的快照）。
         * 这样更新装好但宿主未重启时，UI 立即显示新版号，"检查更新"也不会误报。
         */
        const selfInstalled = () => installedSelfVersion(workspace);

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

        /**
         * DSH 状态归一化（对齐插件 done_pending_restart 归位经验）：
         * - 升级成功后 updater 置 state=done / done_failed 并写入 latestVersion；
         * - 重启后当前版本已追平 latestVersion 时，"升级完成"已生效，不应一直挂着成功徽章；
         * - 读取时若判定已生效则归位为 idle 并覆写磁盘，避免每次请求重复判定。
         * - 最终态 done_pending_restart 理论上不会出现在 DSH 链路，但一并处理以防残留。
         */
        const dshStatusView = () => {
            const raw = readStatus(dshStateDir);
            const baseState = isBusy() ? (raw.state ?? 'running') : (raw.state ?? 'idle');
            const finalsToSettle = ['done', 'done_failed', 'done_pending_restart'];
            if (finalsToSettle.includes(baseState) && typeof raw.latestVersion === 'string' && raw.latestVersion !== '') {
                const currentNow = currentDshVersion(appDir);
                if (currentNow !== 'unknown' && isNewer(raw.latestVersion, currentNow) === false) {
                    const settled = { ...raw, state: 'idle', message: null };
                    writeStatus(dshStateDir, settled);
                    return { ...settled, state: 'idle' };
                }
            }
            return { ...raw, state: baseState };
        };

        /* ---------- GET /dsh-selfupdater/status ---------- */
        registerRoute('GET', '/dsh-selfupdater/status', (_req, res) => {
            const status = dshStatusView();
            const current = currentDshVersion(appDir);
            const latest = status.latestVersion ?? null;
            sendJson(res, 200, {
                currentVersion: current,
                latestVersion: latest,
                // 后端权威判定是否可更新，避免前端仅靠字符串 !== 误判预发布版本号
                updateAvailable: typeof latest === 'string' && latest !== '' ? isNewer(latest, current) === true : false,
                state: status.state ?? 'idle',
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
                    ...readStatus(dshStateDir),
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
            // 先确保 .dsh 目录存在（首次安装/手动清理后可能尚无该目录，教训来自插件写状态 ENOENT 问题）。
            try {
                mkdirSync(dshStateDir, { recursive: true });
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
        /**
         * 插件更新小节只针对本插件自身（dsh-selfupdater）：
         * 其他插件已有各自渠道做更新检测，这里不再扫描 profile 清单。
         * 返回数据与 DSH 小节同款三行模板：当前版本 / 最新版本 / 上次检查。
         */
        const pluginBusy = () => existsSync(pluginLockFile);
        /**
         * 读插件状态并合并"服务端视角"的忙闲标记。
         *
         * 【为何要归位 done_pending_restart】更新成功后 setState 把
         * done_pending_restart 写进磁盘，但"是否已经重启"只有通过比较
         * 真实落盘版本才能判定：重启后 resolveInstalledVersion 读到的新版本
         * 已经等于 targetVersion（更新已生效），此时再把"请重启生效"的徽章
         * 继续挂在界面上就是误导（用户实测"重启后还一直显示请重启"）。
         * 这里在读取时归一化：若状态是 done_pending_restart 且当前真实
         * 运行版本已 >= targetVersion，说明更新已生效，把 state 归位为 idle，
         * 并顺手覆写磁盘，避免每次读都重复判定。
         */
        const pluginStatusView = () => {
            const status = readPluginStatus(dshStateDir);
            const state = status.state ?? (pluginBusy() ? 'running' : 'idle');
            // 仅处理"待重启"终态：targetVersion 存在才可能有归位判定。
            if (state === 'done_pending_restart' && typeof status.targetVersion === 'string' && status.targetVersion !== '') {
                const installedNow = selfInstalled();
                // 重启后真实版本已到目标版本 => 更新已生效，徽章不再有意义。
                // 用 isNewer(target, installed) 判"目标是否还新于已装"：返回 false
                // 即目标不再领先，说明已装版本已追平/超过目标（更新已生效）。
                if (installedNow !== null && isNewer(status.targetVersion, installedNow) === false) {
                    const settled = { ...status, state: 'idle', message: null };
                    writePluginStatus(dshStateDir, settled);
                    return settled;
                }
            }
            return { ...status, state };
        };

        registerRoute('GET', '/dsh-selfupdater/plugins', (_req, res) => {
            const status = pluginStatusView();
            // 上次检查的缓存结果（latest / updateAvailable / checkedAt）存在 updates[SELF_NAME]。
            const cache = status.updates?.[SELF_NAME] ?? {};
            const current = selfInstalled();
            sendJson(res, 200, {
                name: SELF_NAME,
                currentVersion: current,
                latestVersion: cache.latestVersion ?? null,
                // 检查缓存只对"已安装版本"有意义；若装好的新版还没重启
                // （current 已是最新），就不能再按缓存说"有更新"。
                updateAvailable: cache.updateAvailable === true && isNewer(cache.latestVersion, current),
                lastCheck: cache.checkedAt ?? null,
                busy: pluginBusy(),
                state: status.state ?? 'idle',
                message: status.message ?? null,
                updatedAt: status.updatedAt ?? null,
            });
        });

        /* ---------- POST /dsh-selfupdater/plugins/check ---------- */
        registerRoute('POST', '/dsh-selfupdater/plugins/check', async (req, res) => {
            if (!sameOrigin(req)) {
                sendJson(res, 403, { error: 'untrusted request' });
                return;
            }
            // 只查自己这一个包，成功后把结果写入状态文件缓存。
            try {
                const latestVersion = await fetchLatestVersion(SELF_NAME);
                const hasUpdate = isNewer(latestVersion, selfInstalled());
                writePluginStatus(dshStateDir, {
                    ...readPluginStatus(dshStateDir),
                    state: 'idle',
                    message: hasUpdate ? `发现新版本 ${latestVersion}` : '当前已是最新',
                    updates: {
                        [SELF_NAME]: {
                            latestVersion,
                            updateAvailable: hasUpdate,
                            checkedAt: new Date().toISOString(),
                        },
                    },
                    updatedAt: new Date().toISOString(),
                });
                sendJson(res, 200, { updatedCount: hasUpdate ? 1 : 0 });
            } catch (err) {
                host.logger?.warn?.(`[dsh-selfupdater] 插件检查更新失败: ${err.message}`);
                writePluginStatus(dshStateDir, {
                    ...readPluginStatus(dshStateDir),
                    state: 'idle',
                    message: `插件检查更新失败：${err.message}`,
                    updatedAt: new Date().toISOString(),
                });
                sendJson(res, 502, { error: `插件检查更新失败：${err.message}` });
            }
        });

        /* ---------- POST /dsh-selfupdater/plugins/update ---------- */
        /**
         * v0.4.6 重构：不再 spawn 分离脚本后 process.exit(0) 自杀。
         * 旧链路（自杀→脚本接管→拉起 runner→健康检查→回滚）与飞牛OS
         * 守护进程竞态，导致"更新失败+服务停摆+版本没变"。
         * 新链路：202 应答后在本进程内原地安装新版（服务保持运行），
         * 完成后状态置 done_pending_restart，由前端提示用户重启生效。
         */
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
                    message: '插件更新已受理…',
                    startedAt: new Date().toISOString(),
                });
                writeFileSync(pluginLockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now(), by: 'plugin-update' }));
            } catch (err) {
                sendJson(res, 500, { error: `写入锁文件失败：${err.message}` });
                return;
            }
            // fire-and-forget：任务自行写状态文件并释放锁，失败不影响应答。
            void runPluginUpdateTask({ appDir, workspace, logger: host.logger })
                .catch((err) => host.logger?.warn?.(`[dsh-selfupdater] 插件更新任务异常: ${err.message}`));
            host.logger?.info?.('[dsh-selfupdater] 插件更新任务已在进程内启动（服务保持运行）');
            sendJson(res, 202, { accepted: true, note: '更新在后台进行，完成后需重启 DeepSeek Harness 生效' });
        });

        host.logger?.info?.('[dsh-selfupdater] 路由已挂载');
    });
}
