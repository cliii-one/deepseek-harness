/**
 * dsh-selfupdater 浏览器端入口：在设置页注入"DSH版本更新"和"插件更新"两张卡片。
 *
 * 【加载协议 - 重要】DSH 的 ModuleLoader 动态 import 本 bundle 后，
 * 会核对注册表中是否存在本插件的注册记录；bundle 必须在模块执行期间
 * 同步调用 window.__ModuleLoader__.load({ id, factory }) 完成自注册，
 * 否则报 "loaded without registering ... via __ModuleLoader__.load"。
 *
 * 格式完全对照官方 dshmarket@1.29.2 编译产物（client/client.js）：
 *   window.__ModuleLoader__.load({ id: "dshmarket", factory: (require) => { … } });
 * factory 接收宿主注入的 require 函数，用于获取外部依赖
 * （react / @deepseek-ai/dsh-client-runtime 等，由 package.json 中
 * dsh.client.inject 列表声明）；内部用 CommonJS module.exports
 * 返回 { name, inject, apply } 三件套。
 *
 * 主题适配策略（亮暗双模式）：
 * - 不硬编码任何颜色；所有颜色走 --dshsu-* CSS 变量；
 * - 启动时注入一份 <style>，规则只引用变量；
 * - 通过 MutationObserver 监听宿主根节点的 class/data-theme 变化，
 *   结合 prefers-color-scheme 媒体查询推断当前是亮色还是暗色，
 *   把对应调色板写到根节点的 --dshsu-* 变量上；
 * - 所有卡片（DSH 版本更新 + 插件更新）自动跟随主题，无需各自感知明暗。
 */
window.__ModuleLoader__.load({
    id: 'dsh-selfupdater',
    // 工厂函数：宿主传入 require 用于获取注入的外部模块（等价编译前的 import）。
    factory: (require) => {
        const module = { exports: {} };
        const exports = module.exports;

        const react = require('react');
        // 保留原代码里的 h 短名（createElement 的别名），避免大面积改动。
        const h = react.createElement;
        const useState = react.useState;

        // ModuleLoader 约定的插件三件套：id、依赖的服务、入口函数。
        // slots：插槽服务（必需）；locale：文案服务（缺失时 apply 内部会兜底降级）。
        const name = 'dsh-selfupdater';
        const inject = ['slots', 'locale'];

const NS = 'dsh-selfupdater';
const API_BASE = '/dsh-selfupdater';
/** 状态轮询间隔（升级进行中 2 秒，空闲 30 秒）。 */
const POLL_ACTIVE_MS = 2000;
const POLL_IDLE_MS = 30000;
/** 插件清单的空闲刷新间隔（比状态轮询慢一档，避免无谓请求）。 */
const PLUGIN_REFRESH_MS = 60000;

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

/** 调用插件后端接口的统一封装。 */
async function api(path, options) {
    const res = await fetch(`${API_BASE}${path}`, {
        headers: { 'content-type': 'application/json' },
        ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) {
        throw new Error(data.error ?? `HTTP ${res.status}`);
    }
    return data;
}

/* ------------------------------------------------------------------ *
 * 主题系统：探测宿主亮暗模式并注入 --dshsu-* CSS 变量
 * ------------------------------------------------------------------ */

/** 亮色调色板：白底、浅灰边框、高饱和强调色。 */
const THEME_LIGHT = {
    '--dshsu-surface': '#ffffff',
    '--dshsu-subtle': '#f6f8fa',
    '--dshsu-border': 'rgba(15, 23, 42, 0.10)',
    '--dshsu-muted': 'rgba(15, 23, 42, 0.55)',
    '--dshsu-accent': '#2f6bff',
    '--dshsu-accent-soft': 'rgba(47, 107, 255, 0.10)',
    '--dshsu-success': '#15803d',
    '--dshsu-success-soft': 'rgba(21, 128, 61, 0.10)',
    '--dshsu-danger': '#dc2626',
    '--dshsu-danger-soft': 'rgba(220, 38, 38, 0.10)',
    '--dshsu-warn': '#b45309',
    '--dshsu-warn-soft': 'rgba(217, 119, 6, 0.12)',
};

/** 暗色调色板：半透明表面（适配任意暗色宿主背景）、亮化文字与强调色。 */
const THEME_DARK = {
    '--dshsu-surface': 'rgba(255, 255, 255, 0.05)',
    '--dshsu-subtle': 'rgba(255, 255, 255, 0.07)',
    '--dshsu-border': 'rgba(255, 255, 255, 0.13)',
    '--dshsu-muted': 'rgba(255, 255, 255, 0.58)',
    '--dshsu-accent': '#7aa2ff',
    '--dshsu-accent-soft': 'rgba(122, 162, 255, 0.16)',
    '--dshsu-success': '#4ade80',
    '--dshsu-success-soft': 'rgba(74, 222, 128, 0.13)',
    '--dshsu-danger': '#f87171',
    '--dshsu-danger-soft': 'rgba(248, 113, 113, 0.14)',
    '--dshsu-warn': '#fbbf24',
    '--dshsu-warn-soft': 'rgba(251, 191, 36, 0.14)',
};

/**
 * 读取单个元素上的显式主题标记（data-theme 属性或 dark/light 类）。
 * 返回 true=暗色、false=亮色、undefined=该元素未声明。
 * 额外兼容 Semi Design 的 theme-dark/theme-light 类名。
 */
function elementThemeFlag(el) {
    if (!el) return undefined;
    const attr = (el.getAttribute('data-theme') ?? '').toLowerCase();
    if (attr === 'dark' || el.classList?.contains('theme-dark')) return true;
    if (attr === 'light' || el.classList?.contains('theme-light')) return false;
    if (el.classList?.contains('dark')) return true;
    if (el.classList?.contains('light')) return false;
    return undefined;
}

/**
 * 兜底手段：沿 DOM 向上找第一个不透明的背景色，按亮度判断明暗。
 * 解决宿主不写任何主题标记、只换背景配色的实现（本次"深色模式下卡片
 * 区域仍是白底黑字"正是探测不到标记导致的）。跳过插件自身节点，
 * 避免读到自家调色板造成"鸡生蛋"死循环。
 */
function backgroundIsDark(startEl) {
    let node = startEl;
    while (node && node !== document.documentElement) {
        // 插件自己的卡片/容器不算数，向上找宿主的真实背景。
        if (typeof node.className === 'string' && node.className.includes(NS)) {
            node = node.parentElement;
            continue;
        }
        const bg = getComputedStyle(node).backgroundColor;
        const m = /^rgba?\(([^)]+)\)$/i.exec(bg);
        if (m) {
            const [r, g, b, a = 1] = m[1].split(',').map((v) => parseFloat(v));
            if (a > 0) {
                // 经验加权亮度公式：< 0.45 视为深色底。
                return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.45;
            }
        }
        node = node.parentElement; // 透明背景继续向上
    }
    return false;
}

/**
 * 推断宿主当前是否为暗色模式。判定顺序：
 * 1. 卡片所在容器 → body → html 逐级找显式主题标记（右侧容器可能单独带 .dark）；
 * 2. 系统偏好 prefers-color-scheme；
 * 3. 最终兜底：读宿主实际渲染的背景色亮度。
 */
function detectDark() {
    if (typeof document === 'undefined') return false;
    // 从卡片父级开始向上扫（排除卡片本身），找不到再退回 body/html 全局标记。
    const anchor = document.querySelector('.dshsu-card')?.parentElement ?? document.body;
    for (let node = anchor; node; node = node.parentElement) {
        const flag = elementThemeFlag(node);
        if (flag !== undefined) return flag;
    }
    const rootFlag = elementThemeFlag(document.documentElement);
    if (rootFlag !== undefined) return rootFlag;
    if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) return true;
    return backgroundIsDark(anchor ?? document.body);
}

/** 已应用到根节点的主题名（防止 Observer 观察到自己写入的 style 造成死循环）。 */
let appliedTheme = '';

/** 把当前主题对应的调色板写到根节点；主题未变化时不重复写入。 */
function syncThemeVars() {
    if (typeof document === 'undefined') return;
    const theme = detectDark() ? 'dark' : 'light';
    if (theme === appliedTheme) return;
    appliedTheme = theme;
    const palette = theme === 'dark' ? THEME_DARK : THEME_LIGHT;
    for (const [key, value] of Object.entries(palette)) {
        document.documentElement.style.setProperty(key, value);
    }
}

/** 卡片全部静态样式：只引用 --dshsu-* 变量，随主题切换整体换肤。 */
const CARD_CSS = `
.dshsu-card{display:grid;gap:12px;padding:16px;border:1px solid var(--dshsu-border);
  border-radius:12px;background:var(--dshsu-surface);max-width:520px}
.dshsu-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.dshsu-title{display:flex;align-items:center;gap:8px;font-weight:600}
.dshsu-logo{width:22px;height:22px;border-radius:50%;flex:none;display:flex;align-items:center;
  justify-content:center;background:var(--dshsu-accent-soft);color:var(--dshsu-accent);
  font-size:13px;font-weight:700}
/* SVG 更新图标：放在圆形底上，颜色继承强调色，随主题自动换肤 */
.dshsu-icon{flex:none;color:var(--dshsu-accent)}
.dshsu-chip{font-size:12px;padding:2px 9px;border-radius:999px;border:1px solid var(--dshsu-border);
  color:var(--dshsu-muted);white-space:nowrap}
.dshsu-chip-new{color:var(--dshsu-warn);background:var(--dshsu-warn-soft);border-color:transparent;font-weight:600}
.dshsu-rows{display:grid;gap:8px;background:var(--dshsu-subtle);border-radius:8px;padding:10px 12px}
.dshsu-row{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px}
.dshsu-label{color:var(--dshsu-muted)}
.dshsu-value{font-weight:600;font-variant-numeric:tabular-nums}
.dshsu-value-new{color:var(--dshsu-warn)}
.dshsu-msg{font-size:13px;color:var(--dshsu-muted)}
.dshsu-msg-ok{color:var(--dshsu-success)}
.dshsu-msg-bad{color:var(--dshsu-danger)}
.dshsu-progress{display:flex;align-items:center;gap:10px;font-size:13px}
.dshsu-spin{width:15px;height:15px;border-radius:50%;flex:none;
  border:2px solid var(--dshsu-accent-soft);border-top-color:var(--dshsu-accent);
  animation:dshsu-rotate .8s linear infinite}
@keyframes dshsu-rotate{to{transform:rotate(360deg)}}
.dshsu-steps{display:flex;gap:5px}
.dshsu-step{height:4px;flex:1;border-radius:2px;background:var(--dshsu-border);transition:background .3s}
.dshsu-step-done{background:var(--dshsu-accent)}
.dshsu-step-active{background:var(--dshsu-accent);animation:dshsu-pulse 1.1s ease-in-out infinite}
@keyframes dshsu-pulse{50%{opacity:.35}}
.dshsu-actions{display:flex;align-items:center;gap:8px;margin-top:2px}
.dshsu-spacer{flex:1}
.dshsu-btn{appearance:none;border:1px solid var(--dshsu-border);border-radius:8px;cursor:pointer;
  padding:6px 14px;font-size:13px;background:transparent;color:inherit;display:inline-flex;
  align-items:center;gap:7px;transition:opacity .15s,transform .05s}
.dshsu-btn:hover:not(:disabled){background:var(--dshsu-subtle)}
.dshsu-btn:active:not(:disabled){transform:scale(.98)}
.dshsu-btn:disabled{cursor:not-allowed;opacity:.45}
.dshsu-btn-primary:not(:disabled){background:var(--dshsu-accent);border-color:transparent;
  color:#fff;font-weight:600}
.dshsu-btn-primary:hover:not(:disabled){opacity:.88;background:var(--dshsu-accent)}
.dshsu-pill{font-size:12px;padding:2px 9px;border-radius:999px;white-space:nowrap}
.dshsu-pill-ok{color:var(--dshsu-success);background:var(--dshsu-success-soft)}
.dshsu-pill-bad{color:var(--dshsu-danger);background:var(--dshsu-danger-soft)}
/* ---- 插件更新卡片专用 ---- */
.dshsu-plist{display:grid;gap:8px;background:var(--dshsu-subtle);border-radius:8px;padding:10px 12px}
.dshsu-prow{display:flex;align-items:center;gap:10px;font-size:13px;min-width:0}
.dshsu-pmain{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.dshsu-pname{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshsu-pver{color:var(--dshsu-muted);font-size:12px;font-variant-numeric:tabular-nums}
.dshsu-empty{font-size:13px;color:var(--dshsu-muted)}
.dshsu-pill-new{color:var(--dshsu-warn);background:var(--dshsu-warn-soft)}
`;

/** 幂等注入 <style>；重复调用只保留第一份。 */
function injectStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(`${NS}-styles`) !== null) return;
    const style = document.createElement('style');
    style.id = `${NS}-styles`;
    style.textContent = CARD_CSS;
    document.head.appendChild(style);
}

/**
 * 持续跟踪宿主主题：卡片祖先链 + body/html 属性 + 系统偏好三条路都监听。
 * 只监听 subtree 上的 class/data-theme 变化（右侧容器单独切主题也能捕获）；
 * 自己写入的是 style 属性，不在监听范围内，不会造成死循环。
 */
function watchTheme() {
    syncThemeVars();
    if (typeof document === 'undefined') return () => {};
    const observer = new MutationObserver(() => syncThemeVars());
    for (const target of [document.documentElement, document.body]) {
        observer.observe(target, {
            attributes: true,
            attributeFilter: ['class', 'data-theme'],
            subtree: true,
        });
    }
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onChange = () => syncThemeVars();
    media?.addEventListener?.('change', onChange);
    return () => {
        observer.disconnect();
        media?.removeEventListener?.('change', onChange);
    };
}

/* ------------------------------------------------------------------ *
 * UI 组件
 * ------------------------------------------------------------------ */

/** 阶段文案映射：把后端 state 翻译成用户能看懂的中文。 */
const STATE_LABELS = {
    idle: '',
    running: '升级进行中…',
    downloading: '正在下载新版本…',
    swapping: '正在替换程序文件…',
    restarting: '正在重启服务…',
    healthcheck: '正在等待服务就绪…',
    rollback: '升级失败，正在回滚…',
    done: '升级完成',
    done_failed: '已回滚到旧版本',
    error: '升级出错',
};

/** 升级阶段对应的进度条刻度（0-3），用于渲染四段进度。 */
const STATE_STEP = { downloading: 0, swapping: 1, restarting: 2, healthcheck: 3 };

/** 四段式阶段进度条：已完成实心、进行中呼吸闪烁、未开始灰色。 */
function StepBar({ state }) {
    const current = STATE_STEP[state];
    if (current === undefined) return null;
    return h('div', { className: 'dshsu-steps' },
        [0, 1, 2, 3].map((i) => h('div', {
            key: i,
            className: i < current ? 'dshsu-step dshsu-step-done'
                : i === current ? 'dshsu-step dshsu-step-active'
                    : 'dshsu-step',
        })),
    );
}

/**
 * 更新图标：SVG 循环箭头（语义 = 刷新/更新），stroke 用 currentColor
 * 自动跟随文字颜色，亮暗主题都无需额外处理。
 */
function UpdateIcon() {
    return h('svg', {
        className: 'dshsu-icon',
        viewBox: '0 0 24 24',
        width: 15,
        height: 15,
        'aria-hidden': true,
    },
    // 上半圈箭头 + 下半圈箭头组成循环，Material Design "autorenew" 造型。
    h('path', {
        d: 'M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z',
        fill: 'currentColor',
    }));
}

/**
 * 主卡片：展示当前/最新版本 + 检查更新 + 一键升级。
 * 全部状态由父组件轮询 status 接口驱动；样式全部走 CSS 类，
 * 颜色由 --dshsu-* 变量提供，天然兼容亮暗两种主题。
 */
function SelfUpdateCard({ t, status, busy, checking, onCheck, onUpgrade }) {
    const updateAvailable = status?.latestVersion != null
        && status.latestVersion !== status.currentVersion;
    const stage = STATE_LABELS[status?.state] ?? '';

    // 结果消息的语义着色：成功绿 / 失败红 / 其余灰。
    const message = !busy && status?.message ? String(status.message) : '';
    const msgClass = /已是最新|发现新版本|成功|完成/.test(message) ? ' dshsu-msg-ok'
        : /失败|出错|错误/.test(message) || ['error', 'done_failed'].includes(status?.state) ? ' dshsu-msg-bad'
            : '';

    return h('div', { className: 'dshsu-card' },
        // 头部：标题 + 当前版本徽章（有新版时变成琥珀"可更新"徽章）
        h('div', { className: 'dshsu-head' },
            h('div', { className: 'dshsu-title' },
                h(UpdateIcon),
                h('span', null, t.nav),
            ),
            updateAvailable
                ? h('span', { className: 'dshsu-chip dshsu-chip-new' }, `${t.updateAvailable} ${status.latestVersion}`)
                : h('span', { className: 'dshsu-chip' }, status?.currentVersion ?? '—'),
        ),
        // 版本信息两行
        h('div', { className: 'dshsu-rows' },
            h('div', { className: 'dshsu-row' },
                h('span', { className: 'dshsu-label' }, t.currentVersion),
                h('span', { className: 'dshsu-value' }, status?.currentVersion ?? '—'),
            ),
            h('div', { className: 'dshsu-row' },
                h('span', { className: 'dshsu-label' }, t.latestVersion),
                h('span', {
                    className: updateAvailable ? 'dshsu-value dshsu-value-new' : 'dshsu-value',
                }, status?.latestVersion ?? '—'),
            ),
            h('div', { className: 'dshsu-row' },
                h('span', { className: 'dshsu-label' }, t.lastCheck),
                h('span', { className: 'dshsu-value' }, formatTime(status?.lastCheck) ?? t.never),
            ),
        ),
        // 升级进行中：spinner + 阶段文案 + 四段进度条
        busy ? h('div', { role: 'status', style: { display: 'grid', gap: 8 } },
            h('div', { className: 'dshsu-progress' },
                h('span', { className: 'dshsu-spin' }),
                h('span', { style: status?.state === 'rollback' ? { color: 'var(--dshsu-danger)' } : undefined },
                    stage || t.processing),
            ),
            h(StepBar, { state: status?.state }),
        ) : null,
        // 空闲时的结果消息
        message !== '' ? h('div', { className: `dshsu-msg${msgClass}` }, message) : null,
        // 底部操作行：按钮 + 状态胶囊
        h('div', { className: 'dshsu-actions' },
            h('button', {
                type: 'button',
                className: 'dshsu-btn',
                disabled: busy || checking,
                onClick: onCheck,
            },
                checking ? h('span', { className: 'dshsu-spin' }) : null,
                t.checkUpdate,
            ),
            h('button', {
                type: 'button',
                className: updateAvailable && !busy ? 'dshsu-btn dshsu-btn-primary' : 'dshsu-btn',
                disabled: busy || !updateAvailable,
                onClick: onUpgrade,
            }, t.upgradeNow),
            h('span', { className: 'dshsu-spacer' }),
            status?.state === 'done' ? h('span', { className: 'dshsu-pill dshsu-pill-ok' }, t.upgraded)
                : ['error', 'done_failed'].includes(status?.state) ? h('span', { className: 'dshsu-pill dshsu-pill-bad' }, t.failed)
                    : null,
        ),
    );
}

/** ISO 时间转本地短格式；无效输入返回 null。 */
function formatTime(iso) {
    if (typeof iso !== 'string' || iso === '') return null;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString(undefined, {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    });
}

/* ------------------------------------------------------------------ *
 * 插件更新卡片：列出已装插件 + 检查更新 + 一键全部升级
 * ------------------------------------------------------------------ */

/** 插件更新进行中的状态集合（与后端锁文件/state 约定一致）。 */
const PLUGIN_BUSY_STATES = ['running', 'downloading', 'restarting', 'healthcheck', 'rollback'];

/**
 * 插件列表行：包名 + 当前→最新版本 + 可更新徽章。
 * @param p - 单个插件条目 { name, installedVersion, latestVersion, updateAvailable }
 * @param t - 文案对象
 */
function PluginRow({ p, t }) {
    return h('div', { className: 'dshsu-prow' },
        h('div', { className: 'dshsu-pmain' },
            h('span', {
                className: 'dshsu-pname',
                title: p.name,
            }, p.name),
            // 版本行：有新版时显示"当前 → 最新"，一眼看出升级去向。
            h('span', { className: 'dshsu-pver' },
                p.updateAvailable && p.latestVersion != null
                    ? `${p.installedVersion ?? '?'} → ${p.latestVersion}`
                    : (p.installedVersion ?? '?'),
            ),
        ),
        p.updateAvailable
            ? h('span', { className: 'dshsu-pill dshsu-pill-new' }, t.updateAvailable)
            : (p.latestVersion != null ? h('span', { className: 'dshsu-pill dshsu-pill-ok' }, t.upToDate) : null),
    );
}

/**
 * 插件更新卡片。
 * @param props - plugins 插件数组；busy 是否有插件更新在跑；
 *               checking 是否正在检查；msg 结果消息；各事件回调
 */
function PluginUpdateCard({ t, plugins, busy, checking, msg, onCheck, onUpgrade }) {
    const updateCount = plugins.filter((p) => p.updateAvailable).length;
    // 结果消息的语义着色：成功绿 / 失败红 / 其余灰。
    const msgClass = /已是最新|完成|成功/.test(msg) ? ' dshsu-msg-ok'
        : /失败|出错|错误|超时/.test(msg) ? ' dshsu-msg-bad'
            : '';

    return h('div', { className: 'dshsu-card' },
        // 头部：标题 + 可更新数量徽章（无可更新时显示插件总数）
        h('div', { className: 'dshsu-head' },
            h('div', { className: 'dshsu-title' },
                h(UpdateIcon),
                h('span', null, t.pluginNav),
            ),
            updateCount > 0
                ? h('span', { className: 'dshsu-chip dshsu-chip-new' }, `${updateCount} ${t.updatesSuffix}`)
                : h('span', { className: 'dshsu-chip' }, `${plugins.length} ${t.pluginsSuffix}`),
        ),
        // 插件清单（空态给提示）
        plugins.length > 0
            ? h('div', { className: 'dshsu-plist' }, plugins.map((p) => h(PluginRow, { key: p.name, p, t })))
            : h('div', { className: 'dshsu-plist' }, h('div', { className: 'dshsu-empty' }, t.noPlugins)),
        // 更新/检查进行中：spinner + 阶段文案
        busy || checking ? h('div', { role: 'status', className: 'dshsu-progress' },
            h('span', { className: 'dshsu-spin' }),
            h('span', null, busy ? t.pluginUpdating : t.checkingLabel),
        ) : null,
        // 空闲时的结果消息
        !busy && !checking && msg !== '' ? h('div', { className: `dshsu-msg${msgClass}` }, msg) : null,
        // 底部操作行：检查更新 + 一键全部升级
        h('div', { className: 'dshsu-actions' },
            h('button', {
                type: 'button',
                className: 'dshsu-btn',
                disabled: busy || checking,
                onClick: onCheck,
            },
                checking ? h('span', { className: 'dshsu-spin' }) : null,
                t.checkUpdate,
            ),
            h('button', {
                type: 'button',
                className: updateCount > 0 && !busy ? 'dshsu-btn dshsu-btn-primary' : 'dshsu-btn',
                disabled: busy || checking || updateCount === 0,
                onClick: onUpgrade,
            }, t.upgradeAll),
            h('span', { className: 'dshsu-spacer' }),
        ),
    );
}

/* ------------------------------------------------------------------ *
 * 宿主挂载
 * ------------------------------------------------------------------ */

/** 内置双语字典（宿主 locale 服务缺失时的兜底）。 */
const FALLBACK_DICT = {
    zh: {
        nav: 'DSH版本更新', checkUpdate: '检查更新', upgradeNow: '一键升级',
        currentVersion: '当前版本', latestVersion: '最新版本',
        lastCheck: '上次检查', never: '从未', processing: '处理中…',
        updateAvailable: '可更新', upgraded: '已升级', failed: '失败',
        pluginNav: '插件更新', upgradeAll: '一键全部升级',
        pluginsSuffix: '个插件', updatesSuffix: '个可更新',
        noPlugins: '未发现已安装插件', upToDate: '最新',
        pluginUpdating: '插件更新进行中…', checkingLabel: '正在检查更新…',
        checkFailed: '检查更新失败',
    },
    en: {
        nav: 'DSH Update', checkUpdate: 'Check for updates', upgradeNow: 'Upgrade now',
        currentVersion: 'Current', latestVersion: 'Latest',
        lastCheck: 'Last check', never: 'never', processing: 'Working…',
        updateAvailable: 'Update', upgraded: 'Upgraded', failed: 'Failed',
        pluginNav: 'Plugin Updates', upgradeAll: 'Upgrade All',
        pluginsSuffix: ' plugins', updatesSuffix: ' to update',
        noPlugins: 'No installed plugins found', upToDate: 'Latest',
        pluginUpdating: 'Plugin update in progress…', checkingLabel: 'Checking…',
        checkFailed: 'Check failed',
    },
};

/**
 * 浏览器端 apply 入口。
 * @param ctx - 客户端上下文（slots 必需；locale/settingsScope 可选降级）
 */
function apply(ctx) {
    const slots = ctx.slots;
    if (slots === undefined || typeof slots.inject !== 'function') {
        console.warn(`[${NS}] 宿主未提供 slots 服务，设置卡片不可用`);
        return;
    }

    // 样式与主题跟踪只需做一次（两张卡片共享同一套 CSS 类与变量）。
    injectStyles();
    watchTheme();

    // 文案：宿主有 locale 服务就注册双语字典；没有则用内置兜底。
    let dict = FALLBACK_DICT.zh;
    try {
        ctx.locale?.register?.(NS, FALLBACK_DICT);
        if (typeof ctx.locale?.bind === 'function') {
            const bound = ctx.locale.bind(NS);
            dict = (key) => {
                try {
                    const value = bound(key);
                    return typeof value === 'string' && value !== '' ? value : FALLBACK_DICT.zh[key];
                } catch {
                    return FALLBACK_DICT.zh[key];
                }
            };
        }
    } catch { /* locale 服务缺失时用内置兜底文案 */ }

    /** 卡片内部状态（轮询驱动），通过 useState 强制刷新。 */
    let latestStatus = null;
    let checking = false;
    let refresh = () => {};

    async function pollStatus() {
        try {
            latestStatus = await api('/status');
        } catch { /* 服务重启期间拉不到状态属正常 */ }
        refresh();
        // 升级中高频轮询，空闲低频保活。
        setTimeout(pollStatus, isBusyState(latestStatus) ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    }

    function isBusyState(s) {
        return s != null && ['running', 'downloading', 'swapping', 'restarting', 'healthcheck', 'rollback'].includes(s.state);
    }

    /* ---------- 插件更新卡片的状态与动作 ---------- */

    let pluginList = [];
    let pluginBusy = false;
    let pluginMsg = '';
    let pluginChecking = false;
    let pluginRefresh = () => {};

    /** 拉取插件清单（含上次检查缓存的可更新标记）。 */
    async function pollPlugins() {
        try {
            const data = await api('/plugins');
            pluginList = data.plugins ?? [];
            pluginBusy = data.busy === true || PLUGIN_BUSY_STATES.includes(data.state);
            if (!pluginBusy && typeof data.message === 'string' && data.message !== '') {
                pluginMsg = data.message;
            }
        } catch { /* 服务重启期间拉不到属正常 */ }
        pluginRefresh();
    }

    /**
     * 插件更新的轮询循环：独立于 DSH 主程序的状态轮询。
     * 更新进行中走 2 秒高频；空闲时降为低频保活。
     */
    async function pluginPollLoop() {
        await pollPlugins();
        setTimeout(pluginPollLoop, pluginBusy || pluginChecking ? POLL_ACTIVE_MS : PLUGIN_REFRESH_MS);
    }

    /** 检查插件更新：POST /plugins/check 成功后立刻重拉清单拿结果。 */
    async function handlePluginCheck() {
        pluginChecking = true;
        pluginMsg = '';
        pluginRefresh();
        try {
            const result = await api('/plugins/check', { method: 'POST', body: '{}' });
            const n = result.updatedCount ?? 0;
            pluginMsg = `检查完成：${n > 0 ? `${n} 个插件有新版本` : '所有插件均已是最新'}`;
            await pollPlugins();
        } catch (err) {
            console.warn(`[${NS}] 插件检查更新失败:`, err);
            pluginMsg = `${dict('checkFailed')}：${err.message}`;
        } finally {
            pluginChecking = false;
            pluginRefresh();
        }
    }

    /** 一键升级全部插件：受理成功后进入 2 秒高频轮询等结果。 */
    async function handlePluginUpgrade() {
        try {
            await api('/plugins/update', { method: 'POST', body: '{}' });
            pluginMsg = '';
            // 服务即将退出；进入高频轮询等新进程起来后自动恢复进度展示。
            setTimeout(pluginPollLoop, POLL_ACTIVE_MS);
        } catch (err) {
            console.warn(`[${NS}] 触发插件更新失败:`, err);
            pluginMsg = `触发更新失败：${err.message}`;
            pluginRefresh();
        }
    }

    async function handleCheck() {
        checking = true;
        refresh();
        try {
            await api('/check', { method: 'POST', body: '{}' });
        } catch (err) {
            console.warn(`[${NS}] 检查更新失败:`, err);
            // 失败信息立即显示到卡片消息区（随后轮询会用服务端落盘的同样文案覆盖），
            // 避免"点击检测更新毫无反应"的体验。
            latestStatus = { ...latestStatus, state: 'idle', message: `检查更新失败：${err.message}` };
        } finally {
            checking = false;
            await pollStatus();
        }
    }

    async function handleUpgrade() {
        try {
            await api('/perform', { method: 'POST', body: '{}' });
            // 服务即将退出；进入高频轮询等新进程起来后自动恢复。
            setTimeout(pollStatus, POLL_ACTIVE_MS);
        } catch (err) {
            console.warn(`[${NS}] 触发升级失败:`, err);
        }
    }

    /** DSH 版本更新卡片。useState 仅用来拿到强制刷新的开关。 */
    function Card() {
        const [, tick] = useState(0);
        refresh = () => tick((n) => n + 1);
        return h(SelfUpdateCard, {
            t: {
                nav: dict('nav'), checkUpdate: dict('checkUpdate'), upgradeNow: dict('upgradeNow'),
                currentVersion: dict('currentVersion'), latestVersion: dict('latestVersion'),
                lastCheck: dict('lastCheck'), never: dict('never'), processing: dict('processing'),
                updateAvailable: dict('updateAvailable'), upgraded: dict('upgraded'), failed: dict('failed'),
            },
            status: latestStatus,
            busy: isBusyState(latestStatus),
            checking,
            onCheck: handleCheck,
            onUpgrade: handleUpgrade,
        });
    }

    /** 插件更新卡片（同样以 useState 拿强制刷新开关）。 */
    function PluginCard() {
        const [, tick] = useState(0);
        pluginRefresh = () => tick((n) => n + 1);
        return h(PluginUpdateCard, {
            t: {
                pluginNav: dict('pluginNav'), checkUpdate: dict('checkUpdate'),
                upgradeAll: dict('upgradeAll'), updateAvailable: dict('updateAvailable'),
                upToDate: dict('upToDate'), noPlugins: dict('noPlugins'),
                pluginsSuffix: dict('pluginsSuffix'), updatesSuffix: dict('updatesSuffix'),
                pluginUpdating: dict('pluginUpdating'), checkingLabel: dict('checkingLabel'),
            },
            plugins: pluginList,
            busy: pluginBusy,
            checking: pluginChecking,
            msg: pluginMsg,
            onCheck: handlePluginCheck,
            onUpgrade: handlePluginUpgrade,
        });
    }

    // 注册主设置区（与 dshmarket 同款插槽）：第一张 = DSH 版本更新。
    slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: NS,
        order: 45,
        label: () => dict('nav'),
        locale: NS,
    }, Card));

    // 第二张 = 插件更新（order 错开避免排序抖动；id 不同保证注册表唯一）。
    slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: `${NS}.plugin`,
        order: 46,
        label: () => dict('pluginNav'),
        locale: NS,
    }, PluginCard));

    // 若宿主提供 settingsScope（rc.7+），再往"插件"区补一张卡片。
    try {
        ctx.inject?.(['settingsScope'], (scoped) => {
            scoped.slots?.inject?.('settings.plugin.item', () => scoped.slots.register({
                name: 'settings.plugin.item',
                key: NS,
                locale: NS,
            }, () => h(Card)));
        });
    } catch { /* settingsScope 缺失不影响主设置区 */ }

    // 启动两条独立的轮询循环（DSH 状态 + 插件清单）。
    void pollStatus();
    void pluginPollLoop();
}

    // 按 dshmarket 编译产物的收尾格式：把三件套逐个挂到 exports 并返回命名空间对象。
    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
    // 关闭 factory 函数体（对应顶部的 factory: (require) => {）。
}
});
