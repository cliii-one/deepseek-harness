#!/usr/bin/env node
/**
 * dsh-selfupdater 分离式插件升级脚本（独立进程执行，不依赖 DSH 存活）。
 *
 * 为什么必须分离进程：插件文件装在 profile 目录里且已被 DSH 进程加载进内存，
 * Windows 上运行中文件被锁、Linux 上热替换也可能出现半新半旧状态；
 * 所以插件路由只负责"触发后退出"，由本脚本完成：
 *   备份 profile → 从 npm 下载新版 tgz → dsh plugin add 安装 → 重启 → 健康检查 → 失败回滚。
 *
 * 用法（由 lib/index.js 的 POST /plugins/update 自动调用）：
 *   node plugin-updater.mjs --pid <DSH主进程PID> --app-dir <APP目录> \
 *        --workspace <工作区目录> --port <服务端口>
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

/** 解析 --key value 形式的命令行参数。 */
function parseArgs(argv) {
    const out = {};
    for (let i = 2; i < argv.length; i++) {
        if (!argv[i].startsWith('--')) continue;
        const next = argv[i + 1];
        out[argv[i].slice(2)] = next !== undefined && !next.startsWith('--') ? next : true;
    }
    return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * semver 比较（零依赖实现，与 updater.mjs 保持一致）。
 * 返回负数/0/正数；任一侧不是合法 semver 时返回 null。
 */
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function compareVersions(a, b) {
    const pa = SEMVER_RE.exec(String(a ?? '').trim());
    const pb = SEMVER_RE.exec(String(b ?? '').trim());
    if (pa === null || pb === null) return null;
    for (let i = 1; i <= 3; i++) {
        const x = Number(pa[i]);
        const y = Number(pb[i]);
        if (x !== y) return x - y;
    }
    // 有预发布段的一方更小（1.0.0-rc.1 < 1.0.0）；双方都有时逐段比较。
    const preA = pa[4] === undefined ? [] : pa[4].split('.');
    const preB = pb[4] === undefined ? [] : pb[4].split('.');
    if (preA.length === 0 || preB.length === 0) return preB.length - preA.length;
    for (let i = 0; i < Math.max(preA.length, preB.length); i++) {
        const x = preA[i];
        const y = preB[i];
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

/** 仅当 latest 严格高于 installed 才算可升级。 */
function isNewer(latest, installed) {
    const cmp = compareVersions(latest, installed);
    return cmp !== null && cmp > 0;
}

/** 探测端口是否已被监听（占用=true）。 */
function probePort(port, host = '127.0.0.1') {
    return new Promise((resolveProbe) => {
        const socket = net.connect({ host, port });
        socket.on('connect', () => { socket.destroy(); resolveProbe(true); });
        socket.on('error', () => resolveProbe(false));
    });
}

/** 等待端口释放。 */
async function waitPortFree(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!(await probePort(port))) return true;
        await sleep(500);
    }
    return false;
}

/** 进程是否仍存活（kill(pid,0) 只做权限探测不真正发信号）。 */
function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/** 结束旧 DSH 主进程：SIGTERM 给优雅退出机会，超时后 SIGKILL 兜底。 */
async function killProcess(pid) {
    if (!isAlive(pid)) return;
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 8000;
    while (isAlive(pid) && Date.now() < deadline) await sleep(300);
    if (isAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出则忽略 */ }
        await sleep(1000);
    }
}

/* ------------------------------------------------------------------ *
 * 全局上下文与状态落盘
 * ------------------------------------------------------------------ */

const args = parseArgs(process.argv);

/** DSH 应用目录（含 bin/node 与 node_modules/@deepseek-ai/dsh）。 */
const appDir = resolve(String(args['app-dir'] ?? ''));
/**
 * 工作区目录（存放 .dsh 状态目录与插件 profile）。
 * 与 index.js 的 resolveWorkspace 推导链一致：共享目录 > HOME > TRIM_VAR > appDir。
 * index.js 已解析出正确 workspace 并通过 --workspace 传入，这里仅在参数缺失时兜底；
 * 不能只信 TRIM_VAR —— 飞牛部署时 profiles 实际写在 $HOME/.dsh 下。
 */
const workspace = (() => {
    if (args.workspace) return resolve(String(args.workspace));
    const shares = (process.env.TRIM_DATA_SHARE_PATHS ?? '').split(':').map((s) => s.trim()).filter(Boolean);
    for (const dir of [...shares, process.env.HOME ?? '', process.env.TRIM_VAR ?? '', appDir]) {
        if (dir !== '' && existsSync(join(dir, '.dsh'))) return resolve(dir);
    }
    return resolve(shares[0] ?? process.env.HOME ?? process.env.TRIM_VAR ?? appDir);
})();
/** Web 服务端口，健康检查用。 */
const port = parseInt(String(args.port ?? process.env.DSH_PORT ?? '3081'), 10);

const NODE_BIN = join(appDir, 'bin', 'node');
const DSH_BIN = join(appDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
/** 插件 profile 名（与 runner.js / lib/index.js 的约定一致）。 */
const PROFILE = process.env.DSH_PLUGIN_PROFILE ?? 'web';

const dshStateDir = join(workspace, '.dsh');
const statusFile = join(dshStateDir, 'pluginupdate-status.json');
const logFile = join(dshStateDir, 'pluginupdate.log');
const lockFile = join(dshStateDir, 'pluginupdate.lock');
const stagingDir = join(dshStateDir, 'pluginupdate-staging');
const profileDir = join(dshStateDir, 'profiles', PROFILE);
/** 升级前的 profile 完整备份目录（失败回滚用；成功后保留一次供排查）。 */
const bakProfileDir = profileDir + '.pluginupdate-bak';

/** 国内镜像优先的 registry 候选列表（与 index.js 的策略一致）。 */
function registryCandidates() {
    const custom = process.env.DSHSU_REGISTRY_URL?.replace(/\/+$/, '');
    const list = [custom, 'https://mirrors.cloud.tencent.com/npm', 'https://registry.npmjs.org'];
    return [...new Set(list.filter((v) => typeof v === 'string' && v !== ''))];
}

/** 读插件状态文件（不存在返回空对象）。 */
function readStatus() {
    try { return JSON.parse(readFileSync(statusFile, 'utf8')); } catch { return {}; }
}

let status = {};

/** 向日志追加一行（失败静默，日志不能阻断升级流程）。 */
function log(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    try { appendFileSync(logFile, line + '\n'); } catch { /* 忽略 */ }
    console.log(line);
}

/** 合并写入插件状态文件，供 UI 卡片轮询展示进度。 */
function setState(state, message, extra = {}) {
    status = { ...status, state, message: message ?? status.message, updatedAt: new Date().toISOString(), ...extra };
    try { writeFileSync(statusFile, JSON.stringify({ ...status, pid: process.pid }, null, 2)); } catch { /* 同上 */ }
    log(`state=${state}${message ? ` :: ${message}` : ''}`);
}

/** 终态收尾：释放锁文件并退出。 */
function finish(exitCode = 0) {
    try { rmSync(lockFile, { force: true }); } catch { /* 忽略 */ }
    process.exit(exitCode);
}

/* ------------------------------------------------------------------ *
 * registry 查询与 tgz 下载
 * ------------------------------------------------------------------ */

/**
 * 从单个 registry 取包的 latest 版本号与 tgz 下载地址。
 * 注意：镜像返回的 dist.tarball 可能仍指向官方源，这里不直接采用，
 * 而是按 npm 标准路径规则自行拼出镜像侧的下载地址（保证国内可达）。
 */
async function fetchPackument(base, pkgName) {
    const res = await fetch(`${base}/${encodeURIComponent(pkgName)}`, {
        headers: { accept: 'application/json', 'user-agent': 'dsh-selfupdater' },
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    const latest = doc?.['dist-tags']?.latest;
    if (typeof latest !== 'string' || latest === '') throw new Error('未返回 latest');
    // tgz 文件名规则：取包名最后一段 + 版本号（@a/b@1.0.0 → b-1.0.0.tgz）。
    const fileName = `${pkgName.split('/').pop()}-${latest}.tgz`;
    return { latest, tgzUrl: `${base}/${pkgName}/-/${fileName}` };
}

/** 依次尝试所有 registry 候选；全部失败抛出聚合错误。 */
async function fetchLatest(pkgName) {
    const errors = [];
    for (const base of registryCandidates()) {
        try {
            return await fetchPackument(base, pkgName);
        } catch (err) {
            errors.push(`${base}: ${err.message}`);
        }
    }
    throw new Error(errors.join('；'));
}

/** 把 tgz 流式下载到本地 staging 文件。 */
async function downloadTgz(url, destFile) {
    const res = await fetch(url, {
        headers: { 'user-agent': 'dsh-selfupdater' },
        signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) throw new Error(`tgz 下载失败 HTTP ${res.status}`);
    writeFileSync(destFile, Buffer.from(await res.arrayBuffer()));
}

/* ------------------------------------------------------------------ *
 * 外部命令执行
 * ------------------------------------------------------------------ */

/** 以 Promise 方式运行外部命令并收集输出。 */
function runCommand(file, cmdArgs, opts = {}) {
    return new Promise((resolveRun) => {
        const child = spawn(file, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (d) => { stdout += d; });
        child.stderr?.on('data', (d) => { stderr += d; });
        child.on('error', (err) => resolveRun({ code: -1, stdout: '', stderr: String(err) }));
        child.on('close', (code) => resolveRun({ code, stdout, stderr }));
    });
}

/**
 * 用官方 CLI 离线安装 tgz（与 runner.js 内置安装逻辑完全一致）：
 *   node bin/dsh.js plugin --profile <web> add <tgz>
 * 关键环境变量：HOME 必须指向工作区，否则 dsh 会找错用户目录。
 */
async function dshPluginAdd(tgzFile) {
    const result = await runCommand(NODE_BIN, [DSH_BIN, 'plugin', '--profile', PROFILE, 'add', tgzFile], {
        cwd: workspace,
        env: { ...process.env, HOME: workspace },
    });
    if (result.code !== 0) {
        throw new Error(`dsh plugin add 退出码 ${result.code}: ${result.stderr.slice(-400)}`);
    }
    return result.stdout;
}

/**
 * 从 npm 在线重装"当前已装版本"的 dsh-selfupdater（备份丢失时的回滚兜底）。
 * 与常规回滚不同：没有 bak 可还原时，直接重装同版本也能让服务恢复可用。
 */
async function dshPluginAddSelf() {
    const pkgJson = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
    const curVer = String(pkgJson?.dependencies?.['dsh-selfupdater'] ?? '').replace(/^[~^]/, '');
    if (curVer === '') throw new Error('profile 中找不到 dsh-selfupdater 版本记录，无法重装');
    const { tgzUrl } = await fetchPackument(
        registryCandidates().find((b) => b !== undefined) ?? 'https://registry.npmjs.org', 'dsh-selfupdater',
    ).catch(() => ({ tgzUrl: '' }));
    // 拼指定版本的下载地址（fetchPackument 返回的是 latest 的地址，这里按需覆盖版本号）。
    const url = tgzUrl !== ''
        ? tgzUrl.replace(/-\d+\.\d+\.\d+[^/]*\.tgz$/, `-${curVer}.tgz`)
        : `${registryCandidates()[0]}/dsh-selfupdater/-/dsh-selfupdater-${curVer}.tgz`;
    const tgzFile = join(stagingDir, `dsh-selfupdater-${curVer}.tgz`);
    mkdirSync(stagingDir, { recursive: true });
    await downloadTgz(url, tgzFile);
    await dshPluginAdd(tgzFile);
    log(`已从 npm 重装 dsh-selfupdater@${curVer}`);
}

/* ------------------------------------------------------------------ *
 * 重启链与健康检查
 * ------------------------------------------------------------------ */

/**
 * 按 runner.js 的方式重新拉起完整启动链（runner 会再拉起 DSH）。
 * 必须继承当前进程的全部环境变量 —— 飞牛的 TRIM_DATA_SHARE_PATHS 等
 * 变量决定工作区落点，丢失会导致重启后配置"失踪"。
 */
function launchRunnerChain() {
    const runnerJs = join(appDir, 'bin', 'runner.js');
    if (!existsSync(runnerJs)) throw new Error(`找不到启动器 ${runnerJs}，无法重启`);
    const child = spawn(process.execPath, [runnerJs], {
        cwd: workspace,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, TRIM_APPDEST: appDir },
    });
    child.unref();
    log(`已拉起 runner 链 (pid=${child.pid})`);
}

/** 健康检查：轮询本地端口直到有任意 HTTP 响应即算活着。 */
async function waitHealthy(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
            return true;
        } catch { /* 未就绪继续等 */ }
        await sleep(2000);
    }
    return false;
}

/** 失败回滚：还原整个 profile 目录并再次拉起服务。 */
async function rollback() {
    setState('rollback', '安装失败，正在回滚插件 profile …');
    // 防御：备份目录不存在时绝不能 rename（否则就是用户遇到的 ENOENT）。
    if (!existsSync(bakProfileDir)) {
        log(`回滚中止：备份目录不存在 (${bakProfileDir})，尝试直接重建可用 profile`);
        try {
            mkdirSync(profileDir, { recursive: true });
            await dshPluginAddSelf();
            launchRunnerChain();
            const ok = await waitHealthy(60000);
            setState(ok ? 'done_failed' : 'error',
                ok ? '已重装插件并恢复服务' : '恢复后服务仍未就绪，请查看容器日志');
            return ok;
        } catch (err) {
            setState('error', `回滚失败且重装也不成功：${err.message}`);
            return false;
        }
    }
    try {
        rmSync(profileDir, { recursive: true, force: true });
        renameSync(bakProfileDir, profileDir);
    } catch (err) {
        setState('error', `回滚失败：${err.message}。可手动从 ${bakProfileDir} 恢复。`);
        return false;
    }
    launchRunnerChain();
    const ok = await waitHealthy(60000);
    setState(ok ? 'done_failed' : 'error',
        ok ? '已回滚并恢复服务，插件保持旧版本' : '回滚后服务仍未恢复，请查看容器日志');
    return ok;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
    mkdirSync(dshStateDir, { recursive: true });

    // 【孤儿 bak 自愈】上次更新若在"bak 已生成但还没回滚/清理"的窗口内被
    // 中断（进程被杀、断电、看门狗超时直接 exit），会留下一个孤儿备份：
    //   profiles/web.pluginupdate-bak  ← 真正完整的旧 profile 在这里
    //   profiles/web                   ← 可能是空壳或半成品新版本
    // 若不处理，下次 rollback 会因 bak 已不在而报 ENOENT。这里在动手前先救：
    if (!existsSync(profileDir) && existsSync(bakProfileDir)) {
        log('检测到孤儿备份（profile 缺失），自动从 bak 恢复');
        renameSync(bakProfileDir, profileDir);
    } else if (existsSync(bakProfileDir)) {
        // profile 存在且不是本次会话创建的 bak：说明上一次更新已成功结束，
        // 这个 bak 是"成功后保留供排查"的那份；本次升级即将重建备份，清掉旧的。
        log('清理上一次更新遗留的 bak 备份目录');
        rmSync(bakProfileDir, { recursive: true, force: true });
    }

    // 锁文件双端校验：路由触发前会检查；这里再补一道防手动重复执行。
    if (existsSync(lockFile)) throw new Error('已有一次插件更新在进行中（锁文件存在）');

    /**
     * 只更新本插件自身（dsh-selfupdater）：其他插件已有各自的更新渠道，
     * 不再扫描 profile 的 dependencies 清单。
     * 已装版本直接读自己脚本身旁的 package.json，最可靠。
     */
    let selfVersion = '';
    try {
        selfVersion = JSON.parse(
            readFileSync(new URL('./../package.json', import.meta.url), 'utf8'),
        ).version ?? '';
    } catch { /* 读不到版本号则无事可做 */ }
    if (selfVersion === '') {
        setState('error', '无法读取 dsh-selfupdater 自身版本号，更新中止');
        finish(1);
    }
    const installed = [{ name: 'dsh-selfupdater', version: selfVersion }];

    status = { startedAt: new Date().toISOString(), trigger: 'manual' };
    setState('downloading', '正在查询 dsh-selfupdater 的最新版本 …');

    // 阶段一：并发查询每个插件的 latest，筛出真正有新版可升的子集。
    const checks = await Promise.allSettled(installed.map(async (p) => ({ ...p, info: await fetchLatest(p.name) })));
    const pending = [];
    for (const c of checks) {
        if (c.status !== 'fulfilled') {
            log(`查询 ${c.reason?.name ?? '?'} 失败: ${c.reason?.message ?? c.reason}`);
            continue;
        }
        const { name, version, info } = c.value;
        if (isNewer(info.latest, version)) pending.push({ name, currentVersion: version, targetVersion: info.latest, tgzUrl: info.tgzUrl });
    }
    if (pending.length === 0) {
        setState('idle', 'dsh-selfupdater 已是最新版本');
        finish(0);
    }
    log(`待更新插件：${pending.map((p) => `${p.name}@${p.currentVersion}->${p.targetVersion}`).join(', ')}`);

    // 阶段二：备份整个 profile（同分区 rename 原子完成），失败即可整体还原。
    setState('downloading', '正在备份当前插件目录 …');
    rmSync(bakProfileDir, { recursive: true, force: true });
    renameSync(profileDir, bakProfileDir);
    // 注意：不再立即还原备份！备份目录需要保留到更新成功完成，
    // 这样如果更新失败，rollback() 函数才能从备份恢复。
    mkdirSync(profileDir, { recursive: true });
    mkdirSync(stagingDir, { recursive: true });

    // 阶段三：逐个下载 tgz 并离线安装；任一失败立即整体回滚。
    const updated = [];
    for (const item of pending) {
        setState('downloading', `正在下载 ${item.name}@${item.targetVersion} …`, { updating: item.name });
        const tgzFile = join(stagingDir, `${item.name.split('/').pop()}-${item.targetVersion}.tgz`);
        await downloadTgz(item.tgzUrl, tgzFile);
        log(`开始安装 ${item.name}@${item.targetVersion}`);
        await dshPluginAdd(tgzFile);
        updated.push(item);
    }

    // 校验安装结果：profile 里的登记版本必须等于目标版本（防镜像滞后装了旧版）。
    const afterDeps = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')).dependencies ?? {};
    const mismatched = pending.filter((p) => String(afterDeps[p.name] ?? '').replace(/^[~^]/, '') !== p.targetVersion);
    if (mismatched.length > 0) {
        throw new Error(`安装校验失败：${mismatched.map((p) => p.name).join(', ')} 版本不符`);
    }

    // 阶段四：重启 DSH 让新插件代码生效（本脚本启动时 DSH 已随插件路由退出，
    // 但保险起见仍对传入 pid 做一次确认清理），然后等待端口就绪。
    setState('restarting', '正在重启 DeepSeek Harness …');
    const pid = parseInt(String(args.pid ?? ''), 10);
    if (Number.isFinite(pid) && pid > 0) await killProcess(pid);
    await waitPortFree(port, 20000);
    launchRunnerChain();

    setState('healthcheck', '等待服务就绪 …');
    if (await waitHealthy(90000)) {
        rmSync(stagingDir, { recursive: true, force: true });
        // bak 目录保留一次作为手动救砖手段，下次升级前会自动清理。
        setState('done',
            `插件更新完成：dsh-selfupdater@${updated[0]?.targetVersion ?? ''}`,
            { finishedAt: new Date().toISOString() });
    } else {
        await rollback();
    }
    finish(0);
}

// 总看门狗：任何阶段卡死都强制终态，避免 UI 永远显示"更新中"。
setTimeout(() => {
    setState('error', '插件更新超时（8 分钟看门狗触发），请查看 pluginupdate.log');
    finish(2);
}, 8 * 60 * 1000);

main().catch(async (err) => {
    log(`插件更新失败: ${err.stack ?? err}`);
    // 只有已经动过 profile 才需要回滚；查询/下载阶段失败直接报错即可。
    const touched = existsSync(join(dshStateDir, 'profiles')) && status.state !== 'downloading'
        || String(status.message ?? '').includes('备份');
    if (status.state === 'healthcheck' || status.state === 'restarting' || touched) {
        await rollback();
    } else {
        setState('error', String(err.message ?? err));
        // 若 profile 曾被挪走尚未放回，尽力恢复。
        if (!existsSync(profileDir) && existsSync(bakProfileDir)) {
            try { renameSync(bakProfileDir, profileDir); } catch { /* 忽略 */ }
        }
    }
    finish(1);
});

// 进程被外部信号杀死时（NAS 重启容器、kill 等）也要尽力把 profile 放回原位，
// 否则留下的孤儿 bak 会让下一次回滚撞 ENOENT（本次加固的重点场景）。
for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
        try {
            if (!existsSync(profileDir) && existsSync(bakProfileDir)) {
                renameSync(bakProfileDir, profileDir);
                log(`收到 ${sig}，已将 bak 恢复到 profile 原位`);
            }
        } catch { /* 尽力而为 */ }
        finish(143);
    });
}
