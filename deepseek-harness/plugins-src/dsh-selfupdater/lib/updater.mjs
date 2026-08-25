#!/usr/bin/env node
/**
 * dsh-selfupdater 分离升级脚本（独立进程执行，不依赖 DSH 存活）。
 *
 * 为什么必须分离进程：要替换的正是 DSH 脚下运行的 node_modules 目录，
 * 目录被占用期间无法安全换入新版；所以插件本体只负责"触发后退出"，
 * 由本脚本完成：下载 → 原子替换 → 重启 → 健康检查 → 失败回滚。
 *
 * 用法：
 *   node updater.mjs --pid <DSH主进程PID> --app-dir <APP目录> \
 *        --workspace <工作区目录> --port <服务端口> [--pkg @deepseek-ai/dsh]
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件自身安装位置（…/node_modules/dsh-selfupdater），用于定位状态文件所在目录。 */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
 * semver 比较（零依赖实现，逻辑与 dshmarket updates.ts 一致）。
 * 返回负数/0/正数；任一侧不是合法 semver 时返回 null。
 * 规则：正式版 > 同版本号的任何预发布；预发布段数字按数值比较（rc.10 > rc.9）。
 */
const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseSemver(v) {
    const m = SEMVER_RE.exec(String(v ?? '').trim());
    if (m === null) return null;
    return {
        core: [Number(m[1]), Number(m[2]), Number(m[3])],
        pre: m[4] === undefined ? [] : m[4].split('.'),
    };
}

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

/** 仅当 latest 严格高于 installed 才算可升级，避免把已固定的新版降级回去。 */
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

/** 等待端口释放（进程退出后 TIME_WAIT 期间仍可能短暂占用）。 */
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

/** DSH 应用目录（含 node_modules / bin/runner.js），由插件本体解析后传入。 */
const appDir = resolve(String(args['app-dir'] ?? ''));
/** 工作区目录（存放 .dsh 状态目录）。 */
const workspace = resolve(String(args.workspace ?? process.env.TRIM_VAR ?? appDir));
/** Web 服务端口，健康检查用。 */
const port = parseInt(String(args.port ?? process.env.DSH_PORT ?? '3081'), 10);
/** 要升级的包名。 */
const PKG = String(args.pkg ?? '@deepseek-ai/dsh');

const dshStateDir = join(workspace, '.dsh');
const statusFile = join(dshStateDir, 'selfupdate-status.json');
const logFile = join(dshStateDir, 'selfupdate.log');
const lockFile = join(dshStateDir, 'selfupdate.lock');
const stagingDir = join(dshStateDir, 'selfupdate-staging');
const nmDir = join(appDir, 'node_modules');
const bakDir = join(appDir, 'node_modules.selfupdate-bak');
const failedDir = join(appDir, 'node_modules.selfupdate-failed');

let status = {};

/** 向日志文件追加一行（失败静默，日志不能阻断升级流程）。 */
function log(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    try { appendFileSync(logFile, line + '\n'); } catch { /* 日志写失败不影响主流程 */ }
    console.log(line);
}

/** 把最新状态合并写入状态文件，供 UI 卡片轮询展示进度。 */
function setState(state, message, extra = {}) {
    status = {
        ...status,
        state,
        message: message ?? status.message,
        updatedAt: new Date().toISOString(),
        ...extra,
    };
    try { writeFileSync(statusFile, JSON.stringify({ ...status, pid: process.pid }, null, 2)); } catch { /* 同上 */ }
    log(`state=${state}${message ? ` :: ${message}` : ''}`);
}

/** 终态收尾：释放锁文件并退出。 */
function finish(exitCode = 0) {
    try { rmSync(lockFile, { force: true }); } catch { /* 忽略 */ }
    process.exit(exitCode);
}

/** 读取当前安装的主程序版本。 */
function currentDshVersion() {
    try {
        return JSON.parse(readFileSync(join(nmDir, PKG, 'package.json'), 'utf8')).version ?? 'unknown';
    } catch {
        return 'unknown';
    }
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

/** 定位随应用打包的 pnpm（构建时固定安装于 APP_DIR，见 build.sh 步骤 3）。 */
function pnpmCommand() {
    // 首选直接用自带 node 运行 pnpm.cjs，避免依赖 PATH 与 shebang。
    const cjs = join(appDir, 'lib', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
    if (existsSync(cjs)) return { file: process.execPath, args: [cjs] };
    const bin = join(appDir, 'bin', 'pnpm');
    if (existsSync(bin)) return { file: bin, args: [] };
    throw new Error('找不到随应用打包的 pnpm，无法在 staging 安装新版');
}

/* ------------------------------------------------------------------ *
 * 升级各阶段
 * ------------------------------------------------------------------ */

/**
 * 从 npm registry 查询目标包的最新版本号。
 * 直接读完整 packument 的 dist-tags.latest，网络异常抛错由上层处理。
 */
async function fetchLatestVersion(pkg) {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg)}`, {
        headers: { accept: 'application/json', 'user-agent': 'dsh-selfupdater' },
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`registry 查询失败: HTTP ${res.status}`);
    const doc = await res.json();
    const latest = doc?.['dist-tags']?.latest;
    if (typeof latest !== 'string' || latest === '') throw new Error('registry 未返回 latest 版本号');
    return latest;
}

/**
 * 阶段一：下载。把新版安装进独立 staging 目录。
 * 关键点：pnpm 默认用符号链接布局，搬走 node_modules 后链接会全部失效；
 * 通过 node-linker=hoisted 强制实体文件布局，保证 staging/node_modules
 * 可以整体 rename 到 APP_DIR。
 */
async function downloadIntoStaging(target) {
    rmSync(stagingDir, { recursive: true, force: true });
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(
        join(stagingDir, 'package.json'),
        JSON.stringify({ name: 'dsh-selfupdate-staging', private: true, dependencies: { [PKG]: `^${target}` } }, null, 2),
    );
    // 实体文件布局 + 关闭交互确认，保证无人值守可执行。
    writeFileSync(join(stagingDir, '.npmrc'), 'node-linker=hoisted\n');
    const pnpm = pnpmCommand();
    setState('downloading', `正在下载 ${PKG}@${target} …`);
    const result = await runCommand(pnpm.file, [...pnpm.args, 'install', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: stagingDir,
        env: { ...process.env, CI: 'true', npm_config_node_linker: 'hoisted' },
    });
    if (result.code !== 0) {
        throw new Error(`staging 安装失败(pnpm exit ${result.code}): ${result.stderr.slice(-400)}`);
    }
    // 校验装到的确实是目标版本，防止镜像滞后悄悄装了旧版。
    const staged = JSON.parse(readFileSync(join(stagingDir, 'node_modules', PKG, 'package.json'), 'utf8')).version;
    if (staged !== target) throw new Error(`staging 版本不符：期望 ${target}，实际 ${staged}`);
}

/**
 * 阶段二：原子替换 node_modules。
 * 同分区 rename 是原子操作；任一步失败立即反向回滚，不留中间态。
 */
function swapNodeModules() {
    setState('swapping', '正在替换 node_modules …');
    // 清掉上一次升级遗留的备份（保留到本次成功为止的策略：见 plan 第 8 节）。
    rmSync(bakDir, { recursive: true, force: true });
    renameSync(nmDir, bakDir); // 旧目录让位（此步几乎不会失败）
    try {
        renameSync(join(stagingDir, 'node_modules'), nmDir);
    } catch (err) {
        // 新目录就位失败 → 还原旧目录，保持系统可用。
        try { renameSync(bakDir, nmDir); } catch { /* 还原也失败只能报错 */ }
        throw new Error(`新 node_modules 就位失败: ${err.message}（已回滚）`);
    }
}

/**
 * 按 runner.js 的方式重新拉起完整启动链（runner 会再拉起 DSH）。
 * 关键点：必须继承当前进程的全部环境变量 —— 飞牛的 TRIM_DATA_SHARE_PATHS
 * 等变量决定工作区落点，丢失会导致重启后配置"失踪"。仅显式固定
 * TRIM_APPDEST 指向本次换装后的应用目录。
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

/**
 * 健康检查：轮询本地端口直到有任意 HTTP 响应（服务能应答即算活着，
 * 不苛求 200 —— 登录页/404 都证明 Web 服务已起来）。
 */
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

/** 失败回滚：把备份目录还原为 node_modules 并再次拉起服务。 */
async function rollback() {
    setState('rollback', '健康检查失败，正在回滚到旧版本 …');
    try {
        rmSync(failedDir, { recursive: true, force: true });
        renameSync(nmDir, failedDir);       // 新目录先挪走（留作现场排查）
        renameSync(bakDir, nmDir);          // 还原旧目录
    } catch (err) {
        setState('error', `回滚失败：${err.message}。请参考 manifest 内置版本手动救砖。`);
        return false;
    }
    launchRunnerChain();
    const ok = await waitHealthy(60000);
    setState(ok ? 'done_failed' : 'error',
        ok ? `已回滚并恢复服务（${currentDshVersion()}）。新版文件保留在 ${failedDir}` : '回滚后服务仍未恢复，请查看容器日志',
        { latestVersion: status.latestVersion });
    return ok;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function main() {
    mkdirSync(dshStateDir, { recursive: true });
    const current = currentDshVersion();

    // 锁文件双端校验：插件本体触发前会检查；这里再补一道防手动重复执行。
    if (existsSync(lockFile)) throw new Error('已有一次升级在进行中（锁文件存在）');
    writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));

    status = { currentVersion: current, startedAt: new Date().toISOString(), trigger: 'manual' };
    setState('downloading', '正在查询 npm 最新版本 …');

    const target = await fetchLatestVersion(PKG);
    status.latestVersion = target;
    if (!isNewer(target, current)) {
        setState('idle', `当前已是最新版本（${current}）`);
        finish(0);
    }

    log(`发现新版本：${current} -> ${target}`);
    await downloadIntoStaging(target);
    swapNodeModules();

    setState('restarting', '正在重启 DeepSeek Harness …');
    const pid = parseInt(String(args.pid ?? ''), 10);
    if (Number.isFinite(pid) && pid > 0) await killProcess(pid);
    await waitPortFree(port, 20000);
    launchRunnerChain();

    setState('healthcheck', '等待服务就绪 …');
    if (await waitHealthy(90000)) {
        // 成功：清理 staging；bak 目录保留作为手动救砖的最后手段。
        rmSync(stagingDir, { recursive: true, force: true });
        setState('done', `升级完成：${current} -> ${target}`, { finishedAt: new Date().toISOString() });
    } else {
        await rollback();
    }
    finish(0);
}

// 总看门狗：任何阶段卡死都强制终态，避免 UI 永远显示"升级中"。
setTimeout(() => {
    setState('error', '升级超时（8 分钟看门狗触发），请查看 selfupdate.log');
    finish(2);
}, 8 * 60 * 1000);

main().catch(async (err) => {
    log(`升级失败: ${err.stack ?? err}`);
    setState('error', String(err.message ?? err));
    // 若已换目录但尚未回滚，尽力恢复一次。
    if (existsSync(bakDir) && !existsSync(nmDir)) {
        try { renameSync(bakDir, nmDir); } catch { /* 忽略 */ }
    }
    finish(1);
});
