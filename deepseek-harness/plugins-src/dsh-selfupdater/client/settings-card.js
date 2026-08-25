/**
 * dsh-selfupdater 浏览器端入口：在设置页注入"版本更新"卡片。
 *
 * 写法完全对照 dshmarket src/client/index.ts 的模式：
 * - 导出 name / inject / apply(ctx) 三件套，由 ModuleLoader 加载；
 * - 通过 ctx.slots.inject('settings.section', …) 注册主设置区；
 * - 通过嵌套 inject(['settingsScope']) 在插件区注册卡片；
 * - 缺失宿主能力时优雅降级（console.warn 后直接返回，不炸页面）。
 */
import { createElement as h } from 'react';

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

/** 单个版本徽标。 */
function VersionBadge({ label, value, highlight }) {
    return h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
        h('span', { style: { opacity: 0.6 } }, `${label}:`),
        h('strong', { style: highlight ? { color: '#d97706' } : undefined }, value ?? '—'),
    );
}

/**
 * 主卡片：展示当前/最新版本 + 检查更新 + 一键升级。
 * 全部状态由父组件轮询 status 接口驱动，本组件保持无状态。
 */
function SelfUpdateCard({ t, status, busy, onCheck, onUpgrade }) {
    const updateAvailable = status?.latestVersion != null && status.latestVersion !== status.currentVersion;
    const stage = STATE_LABELS[status?.state] ?? '';
    return h('div', { style: { display: 'grid', gap: 10, padding: '4px 0' } },
        h('div', null,
            h(VersionBadge, { label: '当前版本', value: status?.currentVersion }),
            '　',
            h(VersionBadge, { label: '最新版本', value: status?.latestVersion, highlight: updateAvailable }),
        ),
        busy ? h('div', { role: 'status' }, stage || '处理中…') : null,
        !busy && status?.message ? h('div', { style: { opacity: 0.75 } }, status.message) : null,
        h('div', { style: { display: 'flex', gap: 8 } },
            h('button', {
                type: 'button',
                disabled: busy || false,
                onClick: onCheck,
            }, t.checkUpdate),
            h('button', {
                type: 'button',
                disabled: busy || !updateAvailable || false,
                onClick: onUpgrade,
                style: updateAvailable && !busy ? { fontWeight: 600 } : undefined,
            }, t.upgradeNow),
        ),
    );
}

/* ------------------------------------------------------------------ *
 * 宿主挂载
 * ------------------------------------------------------------------ */

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

    // 文案：宿主有 locale 服务就注册双语字典；没有则用内置兜底。
    let dict = { nav: '版本更新', checkUpdate: '检查更新', upgradeNow: '一键升级' };
    try {
        ctx.locale?.register?.(NS, {
            zh: { nav: '版本更新', checkUpdate: '检查更新', upgradeNow: '一键升级' },
            en: { nav: 'Software Update', checkUpdate: 'Check for updates', upgradeNow: 'Upgrade now' },
        });
        if (typeof ctx.locale?.bind === 'function') {
            const bound = ctx.locale.bind(NS);
            dict = (key) => bound(key);
        }
    } catch { /* locale 服务缺失时用内置兜底文案 */ }

    /** 卡片内部状态（轮询驱动），通过重渲染函数刷新。 */
    let latestStatus = null;
    let checking = false;
    let rerender = () => {};

    async function pollStatus() {
        try {
            latestStatus = await api('/status');
        } catch { /* 服务重启期间拉不到状态属正常 */ }
        rerender();
        // 升级中高频轮询，空闲低频保活。
        setTimeout(pollStatus, isBusyState(latestStatus) ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    }

    function isBusyState(s) {
        return s != null && ['running', 'downloading', 'swapping', 'restarting', 'healthcheck', 'rollback'].includes(s.state);
    }

    async function handleCheck() {
        checking = true;
        rerender();
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

    /** 渲染当前卡片。 */
    function Card() {
        return h(SelfUpdateCard, {
            t: typeof dict === 'function' ? { checkUpdate: dict('checkUpdate'), upgradeNow: dict('upgradeNow') } : dict,
            status: latestStatus,
            busy: checking || isBusyState(latestStatus),
            onCheck: handleCheck,
            onUpgrade: handleUpgrade,
        });
    }

    // 注册主设置区（与 dshmarket 同款插槽）。
    slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: NS,
        order: 45,
        label: () => (typeof dict === 'function' ? dict('nav') : dict.nav),
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
