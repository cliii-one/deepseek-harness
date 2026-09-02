// 飞牛(fnOS)运行时补丁 —— 与仓库 scripts/patch.py 保持同步！
// patch.py 在 FPK 构建期打补丁；本模块在插件一键升级（DSH 自更新）路径上、
// 换装前对 staging 里的 node_modules 应用同一组补丁。插件升级路径绕过了
// 构建期，不打补丁的裸 npm 包在局域网访问时会退化（settings are
// unavailable、403 等）。上游代码变形导致匹配失败时，两处一起更新。
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

// 补丁后的标志性替换文本（与 patch.py 的 CRITICAL_MARKERS 对应）
const FNOS_ISLOOPBACK = 'isLoopback: true, // fnOS fix (Issue #2): trust proxy/control panel access as loopback';

/** 遍历目录下所有 .js/.mjs 文件路径 */
function* walkJs(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) yield* walkJs(p);
        else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) yield p;
    }
}

/**
 * 对单个 JS 文本应用补丁规则，返回（可能修改后的）文本。
 * 所有规则均幂等：已打补丁的文本重复进入不会叠加。
 */
function patchCode(code, filePath) {
    let changed = false;

    // 1. CSRF/Origin 拦截放行：经本应用反代/控制页访问即视为可信请求。
    // 注意加"未打过"守卫，否则重复执行会在 return true 后叠加第二个 return true。
    if (code.includes('function isTrustedApiRequest(')
        && !code.includes('function isTrustedApiRequest(request, trustedHosts) { return true;')) {
        code = code.replace(
            'function isTrustedApiRequest(request, trustedHosts) {',
            'function isTrustedApiRequest(request, trustedHosts) { return true;',
        );
        changed = true;
    }

    // 1b. 浏览器端回环判定放行（Issue #2）：局域网/iframe 访问时
    // location.hostname 非回环，settings 等 RPC 被判不可用。
    if (code.includes('function isLoopbackHostname(')
        && !code.includes('function isLoopbackHostname(hostname) { return true;')) {
        code = code.replace(
            'function isLoopbackHostname(hostname) {',
            'function isLoopbackHostname(hostname) { return true;',
        );
        changed = true;
    }

    // 1c. isLoopback 调用点恒真（双保险）。alpha.4 起调用点在 pageLocation 前
    // 多了 `transport?.ownsHost === true ||`：先精确匹配旧串，未命中再用正则
    // 兜底兼容新旧两种形状。
    if (filePath.includes('dsh-client-connection') && basename(filePath) === 'client.js') {
        const before = code;
        let next = code.replace(
            'isLoopback: pageLocation === void 0 || isLoopbackHostname(pageLocation.hostname),',
            FNOS_ISLOOPBACK,
        );
        if (next === before) {
            next = code.replace(
                /isLoopback:\s*(?:transport\?\.ownsHost\s*===\s*true\s*\|\|\s*)?pageLocation\s*===\s*void\s*0\s*\|\|\s*isLoopbackHostname\(pageLocation\.hostname\),/,
                FNOS_ISLOOPBACK,
            );
        }
        changed = changed || next !== before;
        code = next;
    }

    // 2. 目录选择器：把 home 目录指向飞牛共享盘（DeepSeekHarness 所在卷）。
    // 先还原上游形态再重新注入，保证幂等。
    if (filePath.includes('dsh-host-directory-picker-browse') && basename(filePath) === 'index.js') {
        const before = code;
        if (code.includes('import fs from "node:fs";\n')) {
            code = code.replace('import fs from "node:fs";\n', '');
            code = 'import fs from "node:fs";\n' + code;
        } else if (code.includes('import fs from node:fs;\n')) {
            code = code.replace('import fs from node:fs;\n', 'import fs from "node:fs";\n');
        }
        const fnosBlock = 'function fnosTargetHome() {\n'
            + '\ttry {\n'
            + '\t\tif (fs.existsSync("/vol1/@appshare/DeepSeekHarness")) return "/vol1/@appshare/DeepSeekHarness";\n'
            + '\t\tif (fs.existsSync("/vol1")) return "/vol1";\n'
            + '\t} catch (e) {}\n'
            + '\treturn homedir();\n'
            + '}\n'
            + '\t\tconst home = fnosTargetHome();\n'
            + '\t\t';
        const target = 'const home = homedir();';
        if (code.includes('function fnosTargetHome()')) {
            code = code.replace(/function fnosTargetHome\(\) \{[\s\S]*?\n\}\n/, '');
        }
        if (code.includes('const home = fnosTargetHome();')) {
            code = code.replace('const home = fnosTargetHome();', target);
        }
        if (code.includes(target)) {
            code = code.replace(target, fnosBlock); // 首处替换为注入块
            code = code.replaceAll(target, ''); // 其余残留清除
        }
        changed = changed || code !== before;
    }

    return changed ? code : null;
}

/**
 * 对一个 app_root（含 node_modules）应用全部飞牛补丁，并按关键标记复核。
 * 任何关键补丁未命中都抛错——调用方（updater.mjs）在换装前中止升级，
 * 旧版保持原样，天然安全。
 * @param {string} appRoot - 含 node_modules 的应用根目录（staging 与其同构）
 */
export function applyFnosPatches(appRoot) {
    const at = join(appRoot, 'node_modules', '@deepseek-ai');
    if (!existsSync(at)) throw new Error('找不到 node_modules/@deepseek-ai，staging 结构异常');

    let patched = 0;
    for (const p of walkJs(at)) {
        const code = readFileSync(p, 'utf8');
        const next = patchCode(code, p);
        if (next !== null) {
            writeFileSync(p, next, 'utf8');
            patched++;
        }
    }

    // 关键标记复核：以"标志存在"计数（幂等重跑不会误报），缺失即失败
    const markers = {
        'CSRF 信任放行': 'isTrustedApiRequest(request, trustedHosts) { return true;',
        'loopback 信任修复 (Issue #2)': 'isLoopbackHostname(hostname) { return true;',
        '浏览器端 isLoopback 直连': 'isLoopback: true, // fnOS fix',
    };
    const missed = [];
    for (const [label, marker] of Object.entries(markers)) {
        let hits = 0;
        for (const p of walkJs(at)) {
            if (readFileSync(p, 'utf8').includes(marker)) hits++;
        }
        if (hits === 0) missed.push(label);
    }
    if (missed.length > 0) {
        throw new Error(`关键补丁未命中: ${missed.join('、')}（上游代码可能已变更，需同步更新 fnos-patches.mjs 与 patch.py）`);
    }
    console.log(`[fnos-patches] 补丁应用完成: ${patched} 个文件, 关键标记全部命中`);
}
