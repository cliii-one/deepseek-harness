/**
 * 进程内插件更新任务（v0.4.6 起取代旧的分离进程 plugin-updater.mjs）。
 *
 * 【为什么改架构】旧流程：spawn 分离脚本 → DSH 自杀式 process.exit(0) →
 * 脚本等端口释放 → 拉起 runner → 健康检查 → 失败回滚。在飞牛OS 上与系统
 * 守护进程形成竞态：守护检测到 DSH 死亡会立刻拉起新实例占住端口，脚本随后
 * 误判失败并触发回滚，最终表现为"更新失败 + 服务停摆 + 版本没变"。
 *
 * 【新流程】参照插件市场 dshmarket 的成熟做法：
 * 全程不杀宿主进程、不 rename 现有 profile，只在原地把新版 tgz 装入
 * profile（Node 已加载的旧代码继续运行不受影响），装完校验后置状态
 * done_pending_restart，由前端提示用户重启 DeepSeek Harness 使新版本生效。
 *
 * 同时提供"检查更新"用的版本查询能力：
 * 一律走 /latest 版本级端点 —— 整包 packument 会被 Fastly 等 CDN 长时间
 * 缓存，导致"新版本已发布却查不到"（0.4.5 发布后被误判未发布的根因）。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本插件包名（更新的目标就是自己）。 */
export const SELF_NAME = 'dsh-selfupdater';
/** npm registry 查询超时。 */
const FETCH_TIMEOUT_MS = 15000;
/** tgz 下载超时。 */
const DOWNLOAD_TIMEOUT_MS = 180000;
/** dsh plugin add 安装命令超时。 */
const INSTALL_TIMEOUT_MS = 300000;
/** 国内 npm 镜像（腾讯云），直连官方源超时时的第一回退。 */
const NPM_CHINA_MIRROR = 'https://mirrors.cloud.tencent.com/npm';

/* ------------------------------------------------------------------ *
 * semver 比较（零依赖；从 index.js 迁移过来，供两处共用）
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

/** latest 是否严格新于 installed；任一侧非法返回 false。 */
export function isNewer(latest, installed) {
    const cmp = compareVersions(latest, installed);
    return cmp !== null && cmp > 0;
}

/* ------------------------------------------------------------------ *
 * 版本查询（多 registry 回退 + /latest 版本级端点）
 * ------------------------------------------------------------------ */

/** 本次要依次尝试的 registry 地址列表（去重）。 */
function registryCandidates() {
    const custom = process.env.DSHSU_REGISTRY_URL?.replace(/\/+$/, '');
    const list = [custom, NPM_CHINA_MIRROR, 'https://registry.npmjs.org'];
    return [...new Set(list.filter((v) => typeof v === 'string' && v !== ''))];
}

/**
 * 从单个 registry 的 /latest 版本级端点取文档（含 dist.tarball）。
 * 用版本级端点而非整包 packument：后者会被 Fastly 等 CDN 长时间缓存，
 * 出现"包已发布但查不到新版"的假象。
 */
async function fetchVersionDoc(base, pkg) {
    const res = await fetch(`${base}/${encodeURIComponent(pkg)}/latest`, {
        headers: { accept: 'application/json', 'user-agent': 'dsh-selfupdater' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    if (typeof doc?.version !== 'string' || doc.version === '') throw new Error('响应缺少 version 字段');
    return { version: doc.version, tarball: doc?.dist?.tarball ?? null };
}

/**
 * 查询最新版本与下载地址（检查更新与更新任务共用，保证两边结论一致）。
 *
 * 0.4.14 修复：旧实现"第一个成功的 registry 就采用"。腾讯镜像 /latest 端点
 * CDN 缓存陈旧时仍返回旧版本文档，导致"检查更新拿到 npmjs 的新版本、
 * 点更新后任务却被镜像的旧版本骗过"而误判"无需更新"（NAS 0.4.12→0.4.13
 * 实测踩坑）。改为并行查询全部 registry、取 semver 最大的结果：
 * 任何一个镜像拿到新版即生效，单镜像陈旧缓存不再能压制判定。
 *
 * @returns {{version: string, tarball: string|null}} 全部失败时抛聚合错误。
 */
async function fetchLatestRelease(pkg) {
    const candidates = registryCandidates();
    const results = await Promise.allSettled(candidates.map((base) => fetchVersionDoc(base, pkg)));
    let best = null;
    const errors = [];
    results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
            if (best === null || isNewer(r.value.version, best.version)) best = r.value;
        } else {
            errors.push(`${candidates[i]}: ${r.reason.message}`);
        }
    });
    if (best === null) throw new Error(errors.join('；'));
    return best;
}

/** 只取最新版本号（检查更新路由使用）。 */
export async function fetchLatestVersion(pkg) {
    return (await fetchLatestRelease(pkg)).version;
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 读 JSON 文件，不存在/损坏返回空对象。 */
function readJson(file) {
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return {};
    }
}

/** 读 profile 清单里记录的本插件依赖声明（可能是 ^0.4.6，也可能是 file:/…tgz）；无记录返回 null。 */
function profileDeclaredVersion(profileDir) {
    const dep = readJson(join(profileDir, 'package.json'))?.dependencies?.[SELF_NAME];
    return typeof dep === 'string' && dep !== '' ? dep : null;
}

/**
 * 读 profile 下 node_modules 里实际安装的自身版本 —— 唯一权威来源。
 * FPK 等安装方式会把清单声明写成 file:/…tgz 而非版本号（0.4.6 就因此
 * 把"当前版本"显示成了整个 tgz 路径，连带 isNewer 误判"已是最新"）；
 * 且更新装好但宿主未重启时，也只有这里的 package.json 是新版本。读不到返回 null。
 */
function installedVersionFromModules(profileDir) {
    const version = readJson(join(profileDir, 'node_modules', SELF_NAME, 'package.json'))?.version;
    return typeof version === 'string' && version !== '' ? version : null;
}

/** 字符串是否为合法 semver（file: URL、git URL 等非法声明返回 false）。 */
function isSemverString(v) {
    return parseSemver(v) !== null;
}

/** 当前正在运行的自身版本（读本包 package.json；ESM 下用 createRequire 同步读）。 */
function runningVersion() {
    try {
        const require = createRequire(import.meta.url);
        return require('../package.json').version;
    } catch {
        return '0.0.0';
    }
}

/**
 * 解析"已安装的自身版本"（检查更新/状态展示/更新任务三方共用），三级兜底：
 * 1. profile/node_modules 实际落盘的版本（权威；覆盖 file: 安装与未重启场景）；
 * 2. 清单 dependencies 声明（仅当是合法 semver；file: 等 URL 声明不可用）；
 * 3. 正在运行的版本（本地开发/异常兜底）。
 */
function resolveInstalledVersion(profileDir) {
    const fromModules = installedVersionFromModules(profileDir);
    if (fromModules !== null) return fromModules;
    const declared = profileDeclaredVersion(profileDir);
    if (declared !== null && isSemverString(declared.replace(/^[\^~>=<\s]+/, ''))) {
        return declared.replace(/^[\^~>=<\s]+/, '');
    }
    return runningVersion();
}

/**
 * 已安装的自身版本（供"检查更新/状态展示"路由使用）。
 * 必须实时读盘而非模块加载时快照：更新装好但宿主未重启期间，
 * UI 要立即显示新版号，"检查更新"也不能再误报"发现新版本"。
 */
export function installedSelfVersion(workspace) {
    const profileDir = join(workspace, '.dsh', 'profiles', process.env.DSH_PLUGIN_PROFILE ?? 'web');
    return resolveInstalledVersion(profileDir);
}

/**
 * 同步 FPK 内置插件种子目录（APP_DIR/plugins/），防止重启回退。0.4.12 新增。
 *
 * 【为什么要同步种子】runner.js 每次启动都会执行 installBundledPlugins()：
 * 读 bundled.txt 清单，发现"种子 tgz 版本 ≠ profile 已装版本"就用种子重装。
 * 在线更新装上新版后（如 0.4.11），种子还是 FPK 打包时的旧版（如 0.4.10），
 * 重启即被覆盖回旧版 —— 这正是"更新成功但重启后版本回退"的根因。
 *
 * 同步内容：新版 tgz 写入种子目录 + bundled.txt 清单行替换 + 删除旧版 tgz。
 * 同步后 runner 下次启动看到"已装版本 == 种子版本"即跳过重装，更新得以存活。
 *
 * @returns {string|null} 失败原因；成功返回 null。
 */
function syncBundledSeed(appDir, stagingTgz, newVersion) {
    try {
        const seedDir = join(appDir, 'plugins');
        const stagedName = `${SELF_NAME}-${newVersion}.tgz`;
        const listFile = join(seedDir, 'bundled.txt');
        // 无种子目录说明不是 FPK 部署（本地开发等），无需同步。
        if (!existsSync(listFile)) return null;
        // 1. 新版 tgz 就位。
        copyFileSync(stagingTgz, join(seedDir, stagedName));
        // 2. bundled.txt 里本插件的行替换为新文件名（其他插件行不动）。
        const lines = readFileSync(listFile, 'utf8').split('\n')
            .map((line) => /^dsh-selfupdater-[\w.-]+\.tgz$/.test(line.trim()) ? stagedName : line);
        writeFileSync(listFile, lines.join('\n'));
        // 3. 清掉旧版种子 tgz（文件名带版本号，不删则堆积）。
        for (const f of readdirSync(seedDir)) {
            if (f !== stagedName && /^dsh-selfupdater-[\w.-]+\.tgz$/.test(f)) {
                rmSync(join(seedDir, f), { force: true });
            }
        }
        return null;
    } catch (err) {
        return err.message;
    }
}

/**
 * 定位 dsh CLI 入口（原地安装新版的执行器）。
 * 0.4.10 修复：此前硬编码 bin/dsh.js，但 dsh 包实际 bin 是 lib/bin.js
 * （由 package.json bin 字段声明），NAS 上因此报"无法定位 dsh 命令行工具"。
 * 三级定位，任一命中即返回：
 * 1. 读 dsh 包 package.json 的 bin 字段（权威，适配未来布局变化）；
 * 2. 常见候选路径（含新旧两种布局）；
 * 3. 从 DSH 进程自身启动入口（process.argv[1]）向上推导包根再找 bin。
 */
function locateDshBin(appDir) {
    const pkgRoot = join(appDir, 'node_modules', '@deepseek-ai', 'dsh');
    // 1. bin 字段：字符串直接用；对象取 dsh 键，缺失则取第一个值。
    const binField = readJson(join(pkgRoot, 'package.json')).bin;
    const values = binField && typeof binField === 'object' ? Object.values(binField) : [];
    const binRel = typeof binField === 'string' ? binField
        : typeof binField?.dsh === 'string' ? binField.dsh
            : typeof values[0] === 'string' ? values[0]
                : null;
    if (binRel !== null) {
        const p = resolve(pkgRoot, binRel);
        if (existsSync(p)) return p;
    }
    // 2. 常见候选：新布局 lib/bin.js 优先，兼容旧的 bin/dsh.js。
    for (const p of [
        join(pkgRoot, 'lib', 'bin.js'),
        join(pkgRoot, 'bin', 'dsh.js'),
        join(appDir, 'bin', 'dsh.js'),
    ]) {
        if (existsSync(p)) return p;
    }
    // 3. 从 DSH 进程自身入口向上找包根（如 node …/dsh/lib/xxx.js 启动时）。
    if (typeof process.argv[1] === 'string') {
        let dir = dirname(resolve(process.argv[1]));
        for (let i = 0; i < 6; i++) {
            if (readJson(join(dir, 'package.json')).name === '@deepseek-ai/dsh') {
                const p = join(dir, 'lib', 'bin.js');
                if (existsSync(p)) return p;
                break;
            }
            const parent = dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
    }
    throw new Error(`无法定位 dsh 命令行工具（bin 字段与常见路径均未命中，appDir=${appDir}）`);
}

/** 下载 tgz 到本地暂存路径（体积小，直接缓冲写入）。 */
async function downloadTgz(url, destFile) {
    mkdirSync(dirname(destFile), { recursive: true });
    const res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) throw new Error(`下载内容过小（${buf.length} 字节），疑似损坏`);
    writeFileSync(destFile, buf);
}

/** 阻塞式执行子命令：退出码非 0 或超时都抛错，stderr 附在错误信息里。 */
function runCommand(file, cmdArgs, timeoutMs) {
    return new Promise((resolveP, rejectP) => {
        const child = spawn(file, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            rejectP(new Error(`命令超时（${Math.round(timeoutMs / 1000)}s）`));
        }, timeoutMs);
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(value);
        };
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('error', (err) => finish(rejectP, err));
        child.on('close', (code) => {
            if (code === 0) finish(resolveP, stdout.trim());
            else finish(rejectP, new Error(`退出码 ${code}${stderr.trim() ? `：${stderr.trim().slice(-800)}` : ''}`));
        });
    });
}

/* ------------------------------------------------------------------ *
 * 任务主体
 * ------------------------------------------------------------------ */

/**
 * 执行一次插件自更新（进程内异步，不退出宿主）。
 * @param opts.appDir - DSH 应用目录（node_modules 所在处）
 * @param opts.workspace - 工作区目录（.dsh 落盘处）
 * @param opts.logger - 宿主 logger（可选）
 */
export async function runPluginUpdateTask({ appDir, workspace, logger }) {
    const log = (msg) => logger?.info?.(`[dsh-selfupdater] ${msg}`);
    const warnLog = (msg) => logger?.warn?.(`[dsh-selfupdater] ${msg}`);

    const dshStateDir = join(workspace, '.dsh');
    const statusFile = join(dshStateDir, 'pluginupdate-status.json');
    const lockFile = join(dshStateDir, 'pluginupdate.lock');
    const profileName = process.env.DSH_PLUGIN_PROFILE ?? 'web';
    const profileDir = join(dshStateDir, 'profiles', profileName);
    const stagingTgz = join(dshStateDir, 'pluginupdate.staging.tgz');
    const manifestPath = join(profileDir, 'package.json');

    /**
     * 写状态文件（保留 updates 检查缓存等历史字段；失败仅告警不断流程）。
     * 终态约定：done_pending_restart = 装好了但需要重启生效；error = 失败可重试。
     */
    const setState = (state, message, extra = {}) => {
        try {
            mkdirSync(dshStateDir, { recursive: true });
            writeFileSync(statusFile, JSON.stringify({
                ...readJson(statusFile),
                ...extra,
                state,
                message,
                updatedAt: new Date().toISOString(),
            }, null, 2));
        } catch (err) {
            warnLog(`插件状态文件写入失败: ${err.message}`);
        }
    };

    /** 安装前的清单原文快照（安装失败时尽力还原，避免半成品状态）。 */
    let manifestBackup = null;
    try {
        /* 0. 清理旧架构遗留的孤儿备份目录（此前 NAS 上 ENOENT 回滚报错的源头）。 */
        const orphanBak = `${profileDir}.pluginupdate-bak`;
        if (existsSync(orphanBak)) {
            warnLog(`清理遗留备份目录 ${orphanBak}`);
            rmSync(orphanBak, { recursive: true, force: true });
        }

        /* 1. 确定当前版本：读实际落盘的 node_modules（权威来源，见
              resolveInstalledVersion 注释——清单声明可能是 file:/…tgz）。 */
        const installed = resolveInstalledVersion(profileDir);
        setState('running', '正在查询最新版本…', { startedAt: new Date().toISOString() });

        /* 2. 查询最新版本与下载地址。 */
        const release = await fetchLatestRelease(SELF_NAME);
        if (!isNewer(release.version, installed)) {
            log(`已是最新版本 ${installed}，无需更新`);
            // 状态必须是 idle：无需更新不是"待重启"，若错用 done_pending_restart
            // 前端会同时渲染"已是最新"消息与"重启生效"徽章，自相矛盾
            //（NAS 0.4.12→0.4.13 实测踩坑）。消息照常显示，12 秒后自动隐藏。
            setState('idle', `当前已是最新（${installed}），无需更新`);
            return;
        }

        /* 3. 下载新版 tgz 到暂存位置。 */
        if (!release.tarball) throw new Error('registry 未返回 tarball 下载地址');
        setState('downloading', `正在下载 ${SELF_NAME}@${release.version}…`);
        await downloadTgz(release.tarball, stagingTgz);

        /* 4. 记录 profile 清单原文，安装失败时可还原。 */
        manifestBackup = existsSync(manifestPath) ? readFileSync(manifestPath) : null;

        /* 5. 原地安装：调 dsh CLI 把 tgz 装进现有 profile（不 rename、不停机）。
              子进程同步等待结束，与旧版的 detached 分离脚本有本质区别。 */
        setState('swapping', `正在安装 ${release.version}（服务保持运行）…`);
        const dshBin = locateDshBin(appDir);
        await runCommand(
            process.execPath,
            [dshBin, 'plugin', '--profile', profileName, 'add', stagingTgz],
            INSTALL_TIMEOUT_MS,
        );

        /* 6. 校验：实际落盘版本一致 + 入口文件存在。
              不读清单声明——本地 tgz 安装会把声明写成 file: 指向暂存文件，不可靠。 */
        const installedNow = installedVersionFromModules(profileDir);
        if (installedNow !== release.version) {
            throw new Error(`安装后版本异常：期望 ${release.version}，实际 ${installedNow ?? '未安装'}`);
        }
        if (!existsSync(join(profileDir, 'node_modules', SELF_NAME, 'lib', 'index.js'))) {
            throw new Error('入口文件未落盘，安装可能不完整');
        }

        /* 6.5 修正清单声明：dsh plugin add 装本地 tgz 会把依赖写成 file: 指向
              暂存文件，而暂存文件随后会被删除（引用悬空）；改写为精确版本号，
              保证下次重建依赖时能从 registry 正常解析。失败不影响本次安装。 */
        try {
            const manifest = readJson(manifestPath);
            if (manifest.dependencies?.[SELF_NAME] !== release.version) {
                manifest.dependencies = { ...manifest.dependencies, [SELF_NAME]: release.version };
                writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
            }
        } catch (err) {
            warnLog(`清单声明修正失败（不影响已安装文件）: ${err.message}`);
        }

        /* 6.8 同步 FPK 内置种子（须在 finally 删除暂存 tgz 前复制）：
              runner.js 每次启动会用种子重装"版本不一致"的插件，不同步则
              重启即回退到 FPK 打包时的旧版；失败时在完成消息中如实告知。 */
        const seedErr = syncBundledSeed(appDir, stagingTgz, release.version);
        if (seedErr !== null) {
            warnLog(`内置种子同步失败: ${seedErr}`);
        }

        /* 7. 成功：不重启宿主，提示用户重启使新版本生效。 */
        setState('done_pending_restart',
            seedErr === null
                ? `插件已更新到 ${release.version}，请重启 DeepSeek Harness 使新版本生效`
                : `插件已更新到 ${release.version}，但内置种子同步失败（${seedErr}），重启后可能回退到旧版，建议重新安装 FPK`,
            { finishedAt: new Date().toISOString(), targetVersion: release.version });
        log(`插件更新完成（${installed} → ${release.version}），等待用户重启生效`);
    } catch (err) {
        /* 失败兜底：还原清单 + 落盘明确错误，锁在 finally 里释放以便重试。 */
        warnLog(`插件更新失败: ${err.message}`);
        if (manifestBackup !== null) {
            try {
                mkdirSync(dirname(manifestPath), { recursive: true });
                writeFileSync(manifestPath, manifestBackup);
            } catch { /* 还原是尽力而为，不掩盖原始错误 */ }
        }
        setState('error',
            `插件更新失败：${err.message}。可稍后重试，或通过插件市场重新安装`,
            { finishedAt: new Date().toISOString() });
    } finally {
        rmSync(stagingTgz, { force: true }); // 暂存 tgz 无论成败都清掉
        rmSync(lockFile, { force: true });   // 释放更新锁，允许下次发起
    }
}
