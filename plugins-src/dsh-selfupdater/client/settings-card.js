/**
 * dsh-selfupdater 浏览器端入口：在设置页注入"版本更新"卡片。
 *
 * 写法完全对照 dshmarket src/client/index.ts 的模式：
 * - 导出 name / inject / apply(ctx) 三件套，由 ModuleLoader 加载；
 * - 通过 ctx.slots.inject('settings.section', …) 注册主设置区；
 * - 通过嵌套 inject(['settingsScope']) 在插件区注册卡片；
 * - 缺失宿主能力时优雅降级（console.warn 后直接返回，不炸页面）。
 *
 * 主题适配策略（亮暗双模式）：
 * - 不硬编码任何颜色；所有颜色走 --dshsu-* CSS 变量；
 * - 启动时注入一份 <style>，规则只引用变量；
 * - 通过 MutationObserver 监听宿主根节点的 class/data-theme 变化，
 *   结合 prefers-color-scheme 媒体查询推断当前是亮色还是暗色，
 *   把对应调色板写到根节点的 --dshsu-* 变量上；
 * - 两张卡片（主设置区 + 插件区）自动跟随，无需各自感知主题。
 */
import { createElement as h, useState } from 'react';

export const name = 'dsh-selfupdater';
export const inject = ['slots'];

const NS = 'dsh-selfupdater';
const API_BASE = '/dsh-selfupdater';
/** 状态轮询间隔（升级进行中 2 秒，空闲 30 秒）。 */
const POLL_ACTIVE_MS = 2000;
const POLL_IDLE_MS = 30000;

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
 * 推断宿主当前是否为暗色模式。
 * 优先级：根元素/主体的 data-theme 属性 > .dark 类 > 系统偏好。
 * 兼容 Semi/AntD/naive 等常见主题实现，探测不到一律回退媒体查询。
 */
function detectDark() {
    if (typeof document === 'undefined') return false;
    const root = document.documentElement;
    const attr = (root.getAttribute('data-theme')
        ?? document.body?.getAttribute('data-theme') ?? '').toLowerCase();
    if (attr === 'dark' || attr === 'light') return attr === 'dark';
    if (root.classList.contains('dark') || document.body?.classList.contains('dark')) return true;
    if (root.classList.contains('light') || document.body?.classList.contains('light')) return false;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
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

/** 持续跟踪宿主主题：属性变化 + 系统偏好变化两条路都监听。 */
function watchTheme() {
    syncThemeVars();
    if (typeof document === 'undefined') return () => {};
    const observer = new MutationObserver(syncThemeVars);
    observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'data-theme'],
    });
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
    const msgClass = /最新|成功|完成/.test(message) ? ' dshsu-msg-ok'
        : /失败|出错|错误/.test(message) || ['error', 'done_failed'].includes(status?.state) ? ' dshsu-msg-bad'
            : '';

    return h('div', { className: 'dshsu-card' },
        // 头部：标题 + 当前版本徽章（有新版时变成琥珀"可更新"徽章）
        h('div', { className: 'dshsu-head' },
            h('div', { className: 'dshsu-title' },
                h('span', { className: 'dshsu-logo', 'aria-hidden': true }, '⟳'),
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
 * 宿主挂载
 * ------------------------------------------------------------------ */

/** 内置双语字典（宿主 locale 服务缺失时的兜底）。 */
const FALLBACK_DICT = {
    zh: {
        nav: '版本更新', checkUpdate: '检查更新', upgradeNow: '一键升级',
        currentVersion: '当前版本', latestVersion: '最新版本',
        lastCheck: '上次检查', never: '从未', processing: '处理中…',
        updateAvailable: '可更新', upgraded: '已升级', failed: '失败',
    },
    en: {
        nav: 'Software Update', checkUpdate: 'Check for updates', upgradeNow: 'Upgrade now',
        currentVersion: 'Current', latestVersion: 'Latest',
        lastCheck: 'Last check', never: 'never', processing: 'Working…',
        updateAvailable: 'Update', upgraded: 'Upgraded', failed: 'Failed',
    },
};

/**
 * 浏览器端 apply 入口。
 * @param ctx - 客户端上下文（slots 必需；locale/settingsScope 可选降级）
 */
export function apply(ctx) {
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

    async function handleCheck() {
        checking = true;
        refresh();
        try {
            await api('/check', { method: 'POST', body: '{}' });
        } catch (err) {
            console.warn(`[${NS}] 检查更新失败:`, err);
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

    /** 渲染当前卡片。useState 仅用来拿到强制刷新的开关。 */
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

    // 注册主设置区（与 dshmarket 同款插槽）。
    slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: NS,
        order: 45,
        label: () => dict('nav'),
        locale: NS,
    }, Card));

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

    // 启动首轮轮询。
    void pollStatus();
}
