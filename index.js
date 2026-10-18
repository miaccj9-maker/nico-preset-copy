// =====================================================================
// 预设提示词移动/复制 (preset-move-copy) — SillyTavern 扩展
//
// 仿世界书「移动/复制条目到其他世界书」：
//   1. Chat Completion → 提示词管理器的每个提示词条目右侧出现
//      fa-right-left「移动/复制到其他预设」按钮
//   2. 弹窗中选择目标预设（排除当前预设）
//   3. 选择插入位置：
//        · 点击任意行的「插此」/ 组标题的「插入本组」（手机友好）
//        · 或直接拖动 📌 锚点行、拖动目标预设条目重排
//   4. 目标预设有分组时（柏宝箱 baibaiToolkit.presetPromptGroups 或
//      preset-transfer 的 extensions.entryGrouping），弹窗按组展示，
//      锚点放进哪个组，移动/复制后条目就自动归属该组，分组数据同步落盘
//   5. 移动 / 复制后直接写入预设 JSON 文件并同步内存，切换过去即生效
//
// 轻量：仅一个 MutationObserver 监听提示词列表容器 + 一次事件委托，
//       无定时器、无轮询，点击时才读取数据。
//
// 绝对路径 import：兼容 extensions/ 与 third-party/ 两种安装位置
// =====================================================================

import {
    eventSource,
    event_types,
    getRequestHeaders,
    saveSettingsDebounced,
} from '/script.js';
import {
    oai_settings,
    openai_settings,
    openai_setting_names,
    promptManager,
    getChatCompletionPreset,
} from '/scripts/openai.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '/scripts/popup.js';
import { escapeHtml } from '/scripts/utils.js';

// =====================================================================
// 常量
// =====================================================================

const PM_CONTAINER_SEL = '#completion_prompt_manager';
const PM_LIST_SEL = '#completion_prompt_manager_list';
const BTN_CLASS = 'pm-preset-transfer-action';
const PICK_CLASS = 'pm-preset-pick';
const PICKED_CLASS = 'pm-picked';
const BATCH_BAR_ID = 'pmc-batch-bar';
const ANCHOR_CLASS = 'pmx-anchor';
const ANCHOR_ACTIVE_CLASS = 'pmx-anchor-active';
const POSITION_LIST_CLASS = 'pmx-position-list';
const ITEM_CLASS = 'pmx-item';
const GROUP_HEADER_CLASS = 'pmx-group-header';
const GROUP_END_CLASS = 'pmx-group-end';

// 分组数据在预设 extensions 中的路径
const PATH_BAIBAI = 'baibaiToolkit.presetPromptGroups';
const PATH_ENTRY = 'entryGrouping';

// =====================================================================
// 工具函数
// =====================================================================

/**
 * 获取全局提示词顺序使用的虚拟角色 ID（Chat Completion 为 global 策略）
 */
function getDummyId() {
    return promptManager?.configuration?.promptOrder?.dummyId ?? 100001;
}

/**
 * 取得（并兜底创建）预设中全局顺序数组：[{identifier, enabled}, ...]
 */
function getGlobalOrder(preset) {
    if (!Array.isArray(preset.prompt_order)) preset.prompt_order = [];
    const dummyId = getDummyId();
    let entry = preset.prompt_order.find(l => String(l.character_id) === String(dummyId));
    if (!entry) {
        entry = { character_id: dummyId, order: [] };
        preset.prompt_order.push(entry);
    }
    if (!Array.isArray(entry.order)) entry.order = [];
    return entry.order;
}

/**
 * 按点路径安全读取对象
 */
function getPath(obj, path) {
    return path.split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

/**
 * 按点路径安全写入对象（中间节点缺失时创建）
 */
function setPath(obj, path, value) {
    const keys = path.split('.');
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i];
        if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
        cur = cur[k];
    }
    cur[keys[keys.length - 1]] = value;
}

/**
 * 保存预设到服务端（POST /api/presets/save 原样写入 JSON 文件）
 */
async function savePresetFile(name, preset) {
    const response = await fetch('/api/presets/save', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ apiId: 'openai', name, preset }),
    });
    if (!response.ok) {
        throw new Error(`保存预设「${name}」失败：HTTP ${response.status}`);
    }
    return response.json();
}

/**
 * 在已有 identifier 集合中生成不冲突的新 identifier
 */
function makeUniqueIdentifier(base, existing) {
    let candidate = `${base}_copy`;
    let i = 1;
    while (existing.has(candidate)) {
        candidate = `${base}_copy${i++}`;
    }
    return candidate;
}

/**
 * 判断某提示词条目是否允许移动/复制
 * （系统提示词与扩展注入提示词不允许，与原生「移除」按钮的允许范围一致）
 */
function isTransferable(prompt) {
    return !!prompt && prompt.system_prompt !== true && prompt.extension !== true;
}

// =====================================================================
// 分组数据：两种格式统一读入 / 写回
//
// 统一模型：
//   { format: 'baibai' | 'entry' | null,
//     groups: [ { id, name, mode, collapsed, enabled, members: string[] } ] }
//   members 顺序按全局 order 归一（调用方在渲染时按 order 排序展示）
// =====================================================================

/**
 * 读取预设中的分组定义（兼容柏宝箱与 preset-transfer 两种格式）
 */
function readGroups(preset) {
    const ext = (preset && typeof preset.extensions === 'object') ? preset.extensions : {};

    // 1. 柏宝箱 presetPromptGroups：{ groups:[{id,name,order,collapsed,enabled}], prompts:{id:{groupId}} }
    const baibai = getPath(ext, PATH_BAIBAI);
    if (baibai && Array.isArray(baibai.groups) && baibai.groups.length) {
        const prompts = (baibai.prompts && typeof baibai.prompts === 'object') ? baibai.prompts : {};
        const groups = baibai.groups
            .map(g => ({
                id: String(g.id),
                name: String(g.name || '未命名分组'),
                order: Number.isFinite(Number(g.order)) ? Number(g.order) : 0,
                collapsed: !!g.collapsed,
                enabled: g.enabled !== false,
                mode: 'inclusive',
                members: Object.keys(prompts).filter(id => prompts[id]?.groupId === String(g.id)),
            }))
            .sort((a, b) => a.order - b.order);
        return { format: 'baibai', groups };
    }

    // 2. preset-transfer entryGrouping：[{id,name,mode,memberIdentifiers:[...]}]
    const entry = getPath(ext, PATH_ENTRY);
    if (Array.isArray(entry) && entry.length) {
        const groups = entry
            .filter(g => g && (g.id || g.name))
            .map((g, i) => ({
                id: String(g.id || `pt-eg-${i}`),
                name: String(g.name || '未命名分组'),
                order: i,
                collapsed: false,
                enabled: true,
                mode: String(g.mode || 'inclusive'),
                members: Array.isArray(g.memberIdentifiers)
                    ? g.memberIdentifiers.map(String)
                    : resolveAnchorMembers(g, preset),
            }));
        return { format: 'entry', groups };
    }

    return { format: null, groups: [] };
}

/**
 * 旧版锚点格式（startIdentifier/endIdentifier）解析成员
 */
function resolveAnchorMembers(group, preset) {
    if (typeof group.startIdentifier !== 'string' && typeof group.endIdentifier !== 'string') return [];
    const order = getGlobalOrder(preset).map(r => r.identifier);
    const s = order.indexOf(group.startIdentifier);
    const e = order.indexOf(group.endIdentifier);
    if (s === -1 || e === -1) return [];
    const exclusive = String(group.mode || 'inclusive').toLowerCase() === 'exclusive';
    const from = Math.min(s, e) + (exclusive ? 1 : 0);
    const to = Math.max(s, e) - (exclusive ? 1 : 0);
    return from <= to ? order.slice(from, to + 1) : [];
}

/**
 * 按弹窗最终 DOM 顺序重建分组数据并写回预设
 *
 * @param {object} preset 预设完整对象（已在内存中修改）
 * @param {object} model readGroups() 的原始模型（提供格式与组元数据）
 * @param {Array<{id:string, members:string[]}>} finalGroups
 *        最终各组及成员（按 DOM 顺序，含空组）；未分组的条目不在其中
 */
function writeGroups(preset, model, finalGroups) {
    if (!preset.extensions || typeof preset.extensions !== 'object') preset.extensions = {};

    if (model.format === 'baibai') {
        const original = getPath(preset.extensions, PATH_BAIBAI) || {};
        const metaById = new Map((original.groups || []).map(g => [String(g.id), g]));
        const groups = finalGroups.map((g, i) => {
            const meta = metaById.get(g.id) || {};
            return {
                id: g.id,
                name: meta.name ?? g.name,
                order: i,
                collapsed: !!meta.collapsed,
                enabled: meta.enabled !== false,
            };
        });
        const validGroupIds = new Set(groups.map(g => g.id));
        const prompts = {};
        // 保留原 map 中指向「已不存在组」的孤儿引用（UI 会忽略，但不主动删数据）
        for (const [id, meta] of Object.entries(original.prompts || {})) {
            if (meta && !validGroupIds.has(String(meta.groupId))) prompts[id] = meta;
        }
        // 现存组按最新归属重建
        for (const g of finalGroups) {
            for (const id of g.members) prompts[id] = { groupId: g.id };
        }
        setPath(preset.extensions, PATH_BAIBAI, {
            version: original.version || 1,
            groups,
            prompts,
        });
        return;
    }

    if (model.format === 'entry') {
        const original = getPath(preset.extensions, PATH_ENTRY);
        const metaById = new Map((Array.isArray(original) ? original : []).map(g => [String(g.id), g]));
        const arr = finalGroups.map(g => {
            const meta = metaById.get(g.id) || {};
            return {
                id: g.id,
                name: meta.name ?? g.name,
                mode: meta.mode || 'inclusive',
                memberIdentifiers: [...g.members],
            };
        });
        setPath(preset.extensions, PATH_ENTRY, arr);
    }

    // format === null：目标预设原本没有分组，保持不写
}

// =====================================================================
// 多选状态 + 按钮注入
// =====================================================================

// 勾选集合（跨列表 render 保留，render 后由 injectButtons 恢复勾选态）
const selectedIds = new Set();

/**
 * 按 selectedIds 同步单个勾选框的图标与高亮
 */
function syncPickState(pick, identifier) {
    if (!pick || !identifier) return;
    const on = selectedIds.has(identifier);
    pick.classList.toggle('fa-square', !on);
    pick.classList.toggle('fa-square-check', on);
    pick.classList.toggle(PICKED_CLASS, on);
}

/**
 * 遍历当前提示词列表，为缺少按钮/勾选框的可移动条目补缺注入
 */
function injectButtons() {
    if (!promptManager) return;
    const list = document.querySelector(PM_LIST_SEL);
    if (!list) return;

    const items = list.querySelectorAll('li[data-pm-identifier]');
    for (const li of items) {
        const identifier = li.dataset.pmIdentifier;
        const prompt = oai_settings.prompts?.find(p => p && p.identifier === identifier);
        const transferable = isTransferable(prompt);

        const controls = li.querySelector('.prompt_manager_prompt_controls');
        if (!controls) continue;

        // 多选勾选框（最左侧）
        let pick = controls.querySelector(`.${PICK_CLASS}`);
        if (!pick && transferable) {
            pick = document.createElement('span');
            pick.className = `${PICK_CLASS} fa-solid fa-square fa-xs`;
            pick.title = '多选：勾选后可批量移动/复制到其他预设';
            controls.prepend(pick);
        }
        syncPickState(pick, identifier);

        // 单条移动/复制按钮
        if (controls.querySelector(`.${BTN_CLASS}`) || !transferable) continue;
        const btn = document.createElement('span');
        btn.className = `${BTN_CLASS} fa-solid fa-right-left fa-xs`;
        btn.title = '移动/复制到其他预设';
        controls.prepend(btn);
    }

    updateBatchBar();
}

/**
 * 列表上方的批量操作条（幂等创建，未勾选时隐藏）
 */
function injectBatchBar() {
    const list = document.querySelector(PM_LIST_SEL);
    if (!list) return;
    const parent = list.parentElement;
    if (!parent || parent.querySelector(`#${BATCH_BAR_ID}`)) return;

    const bar = document.createElement('div');
    bar.id = BATCH_BAR_ID;
    bar.className = 'pmc-batch-bar';
    bar.innerHTML = `
        <span class="pmc-batch-count">已选 <b class="pmc-batch-n">0</b> 个</span>
        <button type="button" class="menu_button pmc-batch-all">全选可见</button>
        <button type="button" class="menu_button pmc-batch-move">批量移动</button>
        <button type="button" class="menu_button pmc-batch-copy">批量复制</button>
        <button type="button" class="menu_button pmc-batch-clear">清空</button>
    `;
    parent.insertBefore(bar, list);

    bar.addEventListener('click', (event) => {
        if (event.target.closest('.pmc-batch-move')) openMultiTransferPopup();
        else if (event.target.closest('.pmc-batch-copy')) openMultiTransferPopup();
        else if (event.target.closest('.pmc-batch-clear')) clearSelection();
        else if (event.target.closest('.pmc-batch-all')) {
            // 可见条目已全部勾选时再点 = 清空
            const list = document.querySelector(PM_LIST_SEL);
            const visible = list ? [...list.querySelectorAll('li[data-pm-identifier]')].filter(li => {
                const p = oai_settings.prompts?.find(x => x && x.identifier === li.dataset.pmIdentifier);
                return isTransferable(p);
            }) : [];
            if (visible.length > 0 && visible.every(li => selectedIds.has(li.dataset.pmIdentifier))) {
                clearSelection();
            } else {
                selectAllVisible();
            }
        }
    });
}

/**
 * 刷新批量条状态（严格幂等：显示值未变化时不写 DOM，
 * 避免文本节点替换触发 MutationObserver 形成反馈循环）
 */
function updateBatchBar() {
    const bar = document.querySelector(`#${BATCH_BAR_ID}`);
    if (!bar) return;
    const n = selectedIds.size;
    if (bar.classList.contains('pmc-batch-on') !== (n > 0)) {
        bar.classList.toggle('pmc-batch-on', n > 0);
    }
    const cnt = bar.querySelector('.pmc-batch-n');
    if (cnt && cnt.textContent !== String(n)) cnt.textContent = String(n);
}

function clearSelection() {
    selectedIds.clear();
    document.querySelectorAll(`.${PICK_CLASS}`).forEach(pick =>
        syncPickState(pick, pick.closest('li[data-pm-identifier]')?.dataset.pmIdentifier));
    updateBatchBar();
}

function selectAllVisible() {
    const list = document.querySelector(PM_LIST_SEL);
    if (!list) return;
    for (const li of list.querySelectorAll('li[data-pm-identifier]')) {
        const id = li.dataset.pmIdentifier;
        const p = oai_settings.prompts?.find(x => x && x.identifier === id);
        if (isTransferable(p)) selectedIds.add(id);
    }
    document.querySelectorAll(`.${PICK_CLASS}`).forEach(pick =>
        syncPickState(pick, pick.closest('li[data-pm-identifier]')?.dataset.pmIdentifier));
    updateBatchBar();
}

/**
 * 按当前列表可见顺序收集勾选的 identifier（折叠/搜索隐藏的勾选项追加在后）
 */
function getOrderedSelection() {
    const ordered = [];
    const list = document.querySelector(PM_LIST_SEL);
    if (list) {
        for (const li of list.querySelectorAll('li[data-pm-identifier]')) {
            if (selectedIds.has(li.dataset.pmIdentifier)) ordered.push(li.dataset.pmIdentifier);
        }
    }
    for (const id of selectedIds) {
        if (!ordered.includes(id)) ordered.push(id);
    }
    return ordered;
}

function openMultiTransferPopup() {
    if (selectedIds.size === 0) {
        toastr.warning('请先勾选要移动/复制的条目。');
        return;
    }
    openTransferPopup(getOrderedSelection());
}

// =====================================================================
// 弹窗：目标预设 + 分组 + 插入位置
// =====================================================================

/**
 * 渲染目标预设的位置列表（分组区块 + 多个拖拽锚点 + 点击选位）
 *
 * @param {Array<{identifier:string, name:string}>} anchors 待插入条目（每个一个锚点）
 */
function renderPositionList(wrap, targetName, anchors) {
    const targetIndex = openai_setting_names[targetName];
    const target = openai_settings[targetIndex];
    if (!target) {
        wrap.innerHTML = '<div class="pmx-hint">无法读取目标预设。</div>';
        return null;
    }

    const prompts = Array.isArray(target.prompts) ? target.prompts : [];
    const order = getGlobalOrder(target);
    const model = readGroups(target);

    // identifier -> 组 id
    const groupOf = new Map();
    for (const g of model.groups) {
        for (const id of g.members) {
            if (!groupOf.has(id)) groupOf.set(id, g.id);
        }
    }
    const metaById = new Map(model.groups.map(g => [g.id, g]));

    // 按全局 order 顺序输出；首次遇到某组成员时输出该组标题
    const rowsHtml = [];
    const emittedGroups = new Set();
    const orderedIds = [];

    // 组块：标题行 + 显式成员行 + 结束行。结束行把组块边界钉死，
    // 保证未归属条目即使紧邻组块也不会被误计入组内（确认时不改动无关归属）。
    const groupHeaderHtml = (g) => `
        <li class="${GROUP_HEADER_CLASS}" data-group-id="${escapeHtml(g.id)}">
            <span class="pmx-group-icon fa-solid fa-folder-tree"></span>
            <span class="pmx-group-name">${escapeHtml(g.name)}</span>
            <span class="pmx-group-count" data-group-count="${escapeHtml(g.id)}">0</span>
            <button type="button" class="pmx-group-insert menu_button" title="把新条目放到本组末尾">📌 插入本组</button>
        </li>
    `;
    const groupEndHtml = (gid) => `
        <li class="${GROUP_END_CLASS}" data-group-id="${escapeHtml(gid)}"></li>
    `;

    let openGid = null;
    const closeOpen = () => {
        if (openGid) rowsHtml.push(groupEndHtml(openGid));
        openGid = null;
    };

    for (const ref of order) {
        const p = prompts.find(x => x && x.identifier === ref.identifier);
        if (!p) continue; // 悬空引用保留在数据里，不展示
        orderedIds.push(p.identifier);

        const gid = groupOf.get(p.identifier) || null;

        if (gid !== openGid) {
            closeOpen();
            if (gid) {
                if (!emittedGroups.has(gid)) {
                    emittedGroups.add(gid);
                    rowsHtml.push(groupHeaderHtml(metaById.get(gid)));
                } else {
                    // 病态数据：同组成员被打断为多段，再开一段（仍只归属同一组）
                    rowsHtml.push(groupHeaderHtml(metaById.get(gid)));
                }
                openGid = gid;
            }
        }

        rowsHtml.push(`
            <li class="${ITEM_CLASS}" data-pm-pid="${escapeHtml(p.identifier)}">
                <span class="pmx-handle fa-solid fa-grip-vertical" title="拖动排序"></span>
                <span class="pmx-item-name">${escapeHtml(p.name || p.identifier)}</span>
                <button type="button" class="pmx-here menu_button" title="把新条目插到这一行前面">⤓ 插此</button>
            </li>
        `);
    }
    closeOpen();

    // 空组（成员都不在 order 中）追加到最后，仍可放入条目
    for (const g of model.groups) {
        if (!emittedGroups.has(g.id)) {
            rowsHtml.push(groupHeaderHtml(g));
            rowsHtml.push(groupEndHtml(g.id));
        }
    }

    // 锚点行：每个待插入条目一个（默认按源顺序堆叠在末尾、未分组），
    // 第一个为激活态；点击锚点行切换激活，点「插此」作用于激活锚点
    anchors.forEach((a, i) => {
        rowsHtml.push(`
            <li class="${ITEM_CLASS} ${ANCHOR_CLASS}${i === 0 ? ` ${ANCHOR_ACTIVE_CLASS}` : ''}"
                data-anchor-source="${escapeHtml(a.identifier)}">
                <span class="pmx-handle fa-solid fa-grip-vertical" title="拖动选择位置"></span>
                <span class="pmx-anchor-no">${i + 1}</span>
                <span class="pmx-anchor-icon fa-solid fa-map-pin"></span>
                <span class="pmx-item-name">「${escapeHtml(a.name)}」插到此处</span>
                <span class="pmx-anchor-group"></span>
            </li>
        `);
    });

    // 游离条目（prompts 存在但未加入顺序），仅提示
    const orphanHtml = prompts
        .filter(p => p && !orderedIds.includes(p.identifier))
        .map(p => `
            <li class="${ITEM_CLASS} pmx-orphan" data-pm-orphan="1">
                <span class="pmx-handle pmx-handle-empty">∅</span>
                <span class="pmx-item-name">${escapeHtml(p.name || p.identifier)}</span>
                <span class="pmx-orphan-tag">未加入顺序（保持不动）</span>
            </li>
        `)
        .join('');

    const hint = anchors.length > 1
        ? '共 ' + anchors.length + ' 个锚点：点选某个锚点（高亮）后点「⤓ 插此」/「📌 插入本组」定位，'
            + '也可直接拖动手柄；不同锚点可放到不同位置、不同分组。'
        : '点击「⤓ 插此」或「📌 插入本组」选位，也可拖动 📌 锚点行；'
            + '拖动条目可跨组移动，组归属按最终位置自动更新。';

    wrap.innerHTML = `
        <ul class="${POSITION_LIST_CLASS}">${rowsHtml.join('')}</ul>
        ${orphanHtml ? `<ul class="${POSITION_LIST_CLASS} pmx-orphan-list">${orphanHtml}</ul>` : ''}
        <div class="pmx-hint">${hint}</div>
    `;

    const mainList = wrap.querySelector(`ul.${POSITION_LIST_CLASS}`);

    // 统计各组块内实际成员数（标题行 → 结束行）
    const refreshGroupCounts = () => {
        for (const g of model.groups) {
            const hdr = mainList.querySelector(`.${GROUP_HEADER_CLASS}[data-group-id="${CSS.escape(g.id)}"]`);
            if (!hdr) continue;
            let count = 0;
            let cur = hdr.nextElementSibling;
            while (cur && !(cur.classList.contains(GROUP_END_CLASS) && cur.dataset.groupId === g.id)) {
                if (cur.classList.contains(ITEM_CLASS) && !cur.classList.contains(ANCHOR_CLASS)) count++;
                cur = cur.nextElementSibling;
            }
            const counter = hdr.querySelector(`[data-group-count="${CSS.escape(g.id)}"]`);
            if (counter) counter.textContent = count;
        }
    };

    // 点击选位（事件委托，一次绑定）
    // 锚点归组：向前找最近的组标题/结束行；先遇到标题=在组内，先遇到结束行=未分组
    const getActiveAnchor = () => mainList.querySelector(`.${ANCHOR_ACTIVE_CLASS}`)
        || mainList.querySelector(`.${ANCHOR_CLASS}`);

    const refreshAnchorGroupLabels = () => {
        for (const anchor of mainList.querySelectorAll(`.${ANCHOR_CLASS}`)) {
            let cur = anchor.previousElementSibling;
            let gid = null;
            while (cur) {
                if (cur.classList.contains(GROUP_HEADER_CLASS)) { gid = cur.dataset.groupId; break; }
                if (cur.classList.contains(GROUP_END_CLASS)) { gid = null; break; }
                cur = cur.previousElementSibling;
            }
            anchor.dataset.anchorGroup = gid || '';
            const label = anchor.querySelector('.pmx-anchor-group');
            if (label) {
                label.textContent = gid ? `归组：${metaById.get(gid)?.name || ''}` : '未分组';
            }
        }
    };

    mainList.addEventListener('click', (event) => {
        const groupInsert = event.target.closest('.pmx-group-insert');
        if (groupInsert) {
            event.stopPropagation();
            const anchor = getActiveAnchor();
            if (!anchor) return;
            const hdr = groupInsert.closest(`.${GROUP_HEADER_CLASS}`);
            // 锚点移到本组结束行之前（组块末尾）
            const end = mainList.querySelector(
                `.${GROUP_END_CLASS}[data-group-id="${CSS.escape(hdr.dataset.groupId)}"]`,
            );
            if (end) end.before(anchor); else mainList.appendChild(anchor);
            refreshAnchorGroupLabels();
            refreshGroupCounts();
            return;
        }

        const here = event.target.closest('.pmx-here');
        if (here) {
            event.stopPropagation();
            const anchor = getActiveAnchor();
            if (!anchor) return;
            const row = here.closest(`.${ITEM_CLASS}`);
            if (row && !row.classList.contains(ANCHOR_CLASS)) row.before(anchor);
            refreshAnchorGroupLabels();
            refreshGroupCounts();
            return;
        }

        // 点击锚点行本身（非手柄拖拽区）→ 激活该锚点
        const anchorClicked = event.target.closest(`.${ANCHOR_CLASS}`);
        if (anchorClicked && !event.target.closest('.pmx-handle')) {
            for (const a of mainList.querySelectorAll(`.${ANCHOR_CLASS}`)) {
                a.classList.toggle(ANCHOR_ACTIVE_CLASS, a === anchorClicked);
            }
        }
    });

    // 拖拽排序（jQuery UI 随酒馆加载，touch-punch 已全局加载，手机端可用）
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    const $mainList = $(mainList);
    if ($mainList.sortable('instance') !== undefined) $mainList.sortable('destroy');
    $mainList.sortable({
        items: `li.${ITEM_CLASS}`, // 组标题/结束行不可拖，只作边界与放置目标
        axis: 'y',
        handle: '.pmx-handle',
        placeholder: 'ui-sortable-placeholder',
        forcePlaceholderSize: true,
        tolerance: 'pointer',
        delay: isMobile ? 120 : 0,
        update: () => {
            refreshAnchorGroupLabels();
            refreshGroupCounts();
        },
    });

    refreshGroupCounts();
    refreshAnchorGroupLabels();
    return model;
}

/**
 * 从弹窗 DOM 计算最终顺序与分组归属（多锚点）
 *
 * 输出统一的混合序列 slots：
 *   { id: 目标预设已有 identifier } 或 { newFrom: 源 identifier }
 * 组 members 同样为 slot 数组（同一对象引用），转移时统一映射。
 *
 * @returns {{ orderedIds: string[],
 *            slots: Array<{id?:string, newFrom?:string}>,
 *            anchors: Array<{sourceId:string, groupId:string}>,
 *            finalGroups: Array<{id:string, name:string, members:Array}> }}
 */
function collectPositionResult(wrap, model) {
    const mainList = wrap.querySelector(`ul.${POSITION_LIST_CLASS}`);
    const metaById = new Map(model.groups.map(g => [g.id, g]));

    const orderedIds = [];
    const slots = [];
    const anchors = [];
    const membersByGroup = new Map();
    let currentGroupId = null;
    const groupOrder = [];

    for (const li of mainList.children) {
        if (li.classList.contains(GROUP_HEADER_CLASS)) {
            currentGroupId = li.dataset.groupId;
            if (!groupOrder.includes(currentGroupId)) groupOrder.push(currentGroupId);
            if (!membersByGroup.has(currentGroupId)) membersByGroup.set(currentGroupId, []);
            continue;
        }
        if (li.classList.contains(GROUP_END_CLASS)) {
            // 组块结束，之后为未分组区域
            currentGroupId = null;
            continue;
        }
        if (li.classList.contains(ANCHOR_CLASS)) {
            const sourceId = li.dataset.anchorSource;
            li.dataset.anchorGroup = currentGroupId || '';
            const slot = { newFrom: sourceId };
            slots.push(slot);
            anchors.push({ sourceId, groupId: currentGroupId || '' });
            if (currentGroupId) {
                if (!membersByGroup.has(currentGroupId)) membersByGroup.set(currentGroupId, []);
                membersByGroup.get(currentGroupId).push(slot);
            }
            continue;
        }
        const pid = li.dataset.pmPid;
        if (!pid) continue;
        orderedIds.push(pid);
        const slot = { id: pid };
        slots.push(slot);
        if (currentGroupId) {
            if (!membersByGroup.has(currentGroupId)) membersByGroup.set(currentGroupId, []);
            membersByGroup.get(currentGroupId).push(slot);
        }
    }

    // 组标题出现顺序为准（含空组；同组多段时聚合到同一组）
    const finalGroups = [...new Set(groupOrder)].map(id => ({
        id,
        name: metaById.get(id)?.name || id,
        members: membersByGroup.get(id) || [],
    }));

    return { orderedIds, slots, anchors, finalGroups };
}

/**
 * 打开移动/复制弹窗（单条或多条）
 * @param {string|string[]} identifierOrList
 */
async function openTransferPopup(identifierOrList) {
    const identifiers = Array.isArray(identifierOrList)
        ? identifierOrList
        : [identifierOrList];
    const sourcePrompts = identifiers
        .map(id => oai_settings.prompts?.find(p => p && p.identifier === id))
        .filter(p => p && isTransferable(p));
    if (sourcePrompts.length === 0) return;

    // 锚点清单（深拷贝在转移时进行，这里只读名称）
    const anchorItems = sourcePrompts.map(p => ({
        identifier: p.identifier,
        name: p.name || p.identifier,
    }));

    const currentPresetName = oai_settings.preset_settings_openai;
    const targetNames = Object.keys(openai_setting_names).filter(n => n !== currentPresetName);

    if (targetNames.length === 0) {
        toastr.warning('没有其他预设可移动/复制。');
        return;
    }

    const container = document.createElement('div');

    const title = document.createElement('div');
    title.className = 'pmx-popup-title';
    title.innerHTML = anchorItems.length === 1
        ? `移动/复制「<b>${escapeHtml(anchorItems[0].name)}</b>」到：`
        : `移动/复制选中的 <b>${anchorItems.length}</b> 个条目到：`;
    container.appendChild(title);

    const select = document.createElement('select');
    select.className = 'text_pole wide100p marginTop10';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '-- 选择目标预设 --';
    select.appendChild(placeholder);
    for (const name of targetNames) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
    }
    select.value = targetNames[0];
    container.appendChild(select);

    const label = document.createElement('div');
    label.className = 'pmx-section-label';
    label.textContent = '插入位置';
    container.appendChild(label);

    const positionWrap = document.createElement('div');
    container.appendChild(positionWrap);

    // 保存当前目标预设的分组模型（切换目标时重建）
    let currentModel = { format: null, groups: [] };
    const renderPositions = () => {
        currentModel = renderPositionList(positionWrap, select.value, anchorItems)
            || { format: null, groups: [] };
    };
    select.addEventListener('change', renderPositions);
    renderPositions();

    const popup = new Popup(container, POPUP_TYPE.CONFIRM, '', {
        wide: true,
        cancelButton: '取消',
        customButtons: [
            { text: '移动', result: POPUP_RESULT.CUSTOM1 },
            { text: '复制', result: POPUP_RESULT.CUSTOM2 },
        ],
    });
    popup.okButton.style.display = 'none';

    // Popup 在 resolve 前会把 dialog 整体移出 DOM（detach 后 jQuery sortable
    // 可能改变其内部子树顺序），因此在「移动/复制」按钮点击的捕获阶段
    // （DOM 尚在且为最终状态）同步收集位置结果。
    let capturedPosition = null;
    let capturedTarget = '';
    popup.dlg.addEventListener('click', (event) => {
        // 注意：Popup 自定义按钮是 <div class="result-control">，不是 <button>
        const btn = event.target.closest('.result-control');
        if (!btn) return;
        const text = btn.textContent.trim();
        if (text === '移动' || text === '复制') {
            capturedTarget = select.value;
            capturedPosition = collectPositionResult(positionWrap, currentModel);
        }
    }, true);

    const result = await popup.show();

    if (!result) return;
    const targetName = capturedTarget || select.value;
    if (!targetName) {
        toastr.warning('请先选择目标预设。');
        return;
    }

    const positionResult = capturedPosition;
    if (!positionResult) {
        toastr.warning('未获取到插入位置，请重试。');
        return;
    }

    const move = result === POPUP_RESULT.CUSTOM1;
    try {
        await transferPrompts(identifiers, targetName, currentModel, positionResult, move);
    } catch (err) {
        console.error('[preset-move-copy]', err);
        toastr.error(err?.message || '移动/复制失败。');
    }
}

// =====================================================================
// 核心：移动 / 复制
// =====================================================================

/**
 * 批量移动/复制（单条是多条的特例）
 *
 * @param {string[]} sourceIdentifiers 源条目 identifier 列表
 * @param {string} targetName 目标预设名
 * @param {object} model 目标预设 readGroups 模型
 * @param {object} positionResult collectPositionResult 输出（多锚点混合序列）
 * @param {boolean} move true=移动（源删除），false=复制
 */
async function transferPrompts(sourceIdentifiers, targetName, model, positionResult, move) {
    const { orderedIds, slots, finalGroups } = positionResult;
    const targetIndex = openai_setting_names[targetName];
    if (targetIndex === undefined) throw new Error(`找不到目标预设「${targetName}」。`);

    const sourcePresetName = oai_settings.preset_settings_openai;
    const sourceSet = new Set(sourceIdentifiers);
    const sourcePrompts = sourceIdentifiers
        .map(id => oai_settings.prompts.find(p => p && p.identifier === id))
        .filter(Boolean);
    if (sourcePrompts.length === 0) throw new Error('源提示词不存在。');

    // 深拷贝目标预设（内存缓存 → 改写 → 整体写回，保留目标预设全部字段）
    const targetPreset = structuredClone(openai_settings[targetIndex]);
    if (!Array.isArray(targetPreset.prompts)) targetPreset.prompts = [];

    // 源条目在当前预设中的启用状态
    const sourceOrder = getGlobalOrder(oai_settings);
    const enabledMap = new Map();
    for (const id of sourceIdentifiers) {
        const ref = sourceOrder.find(r => r.identifier === id);
        enabledMap.set(id, ref ? !!ref.enabled : false);
    }

    // 深拷贝每个待转移条目，处理 identifier 冲突；建立 sourceId → 新 id 映射
    const newIdMap = new Map();
    const renamedCount = { n: 0 };
    const existingIds = new Set(targetPreset.prompts.map(p => p && p.identifier));
    for (const sp of sourcePrompts) {
        const moved = structuredClone(sp);
        if (existingIds.has(moved.identifier)) {
            moved.identifier = makeUniqueIdentifier(moved.identifier, existingIds);
            renamedCount.n++;
        }
        existingIds.add(moved.identifier);
        newIdMap.set(sp.identifier, moved.identifier);
        targetPreset.prompts.push(moved);
    }

    // 按混合序列一次重建全局 order
    const targetOrder = getGlobalOrder(targetPreset);
    const oldRefMap = new Map(targetOrder.map(r => [r.identifier, r]));
    const rebuilt = slots.map((s) => {
        if (s.newFrom !== undefined) {
            return { identifier: newIdMap.get(s.newFrom), enabled: enabledMap.get(s.newFrom) ?? false };
        }
        return oldRefMap.get(s.id) ?? { identifier: s.id, enabled: false };
    });
    // 保留未在排序列表中展示的悬空引用（数据不丢）
    for (const ref of targetOrder) {
        if (!orderedIds.includes(ref.identifier)) rebuilt.push(ref);
    }
    const orderEntry = targetPreset.prompt_order.find(
        l => String(l.character_id) === String(getDummyId()),
    );
    orderEntry.order = rebuilt;

    // 重建分组数据：members 中的锚点占位映射为新 id；原组悬空成员补回组末
    if (model.format) {
        const visibleIds = new Set(orderedIds);
        const groupsWithNew = finalGroups.map((g) => {
            const memberIds = g.members.map((s) =>
                (s.newFrom !== undefined ? newIdMap.get(s.newFrom) : s.id));
            const orig = model.groups.find(x => x.id === g.id);
            if (orig) {
                for (const id of orig.members) {
                    if (!visibleIds.has(id) && !memberIds.includes(id)) memberIds.push(id);
                }
            }
            return { id: g.id, name: g.name, members: memberIds };
        });
        writeGroups(targetPreset, model, groupsWithNew);
    }

    // 写盘目标预设
    await savePresetFile(targetName, targetPreset);
    openai_settings[targetIndex] = targetPreset;

    if (move) {
        // 批量从当前预设的 prompts 中移除
        for (const id of sourceIdentifiers) {
            const idx = oai_settings.prompts.findIndex(p => p && p.identifier === id);
            if (idx !== -1) oai_settings.prompts.splice(idx, 1);
        }
        // 从所有顺序列表中移除引用
        for (const list of oai_settings.prompt_order || []) {
            if (!Array.isArray(list.order)) continue;
            for (let i = list.order.length - 1; i >= 0; i--) {
                if (sourceSet.has(list.order[i]?.identifier)) list.order.splice(i, 1);
            }
        }
        // 批量清理源预设分组中对这些条目的引用
        const sourceModel = readGroups(oai_settings);
        if (sourceModel.format) {
            const sourceFinal = sourceModel.groups
                .map(g => ({
                    id: g.id,
                    name: g.name,
                    members: g.members.filter(id => !sourceSet.has(id)),
                }));
            writeGroups(oai_settings, sourceModel, sourceFinal);
        }

        // 写盘当前预设（与官方「更新预设」按钮一致，白名单 preset 体）
        const presetBody = getChatCompletionPreset(oai_settings);
        await savePresetFile(sourcePresetName, presetBody);
        const currentIndex = openai_setting_names[sourcePresetName];
        if (currentIndex !== undefined) Object.assign(openai_settings[currentIndex], presetBody);

        saveSettingsDebounced();
        promptManager?.render();
    }

    clearSelection();

    const label = sourcePrompts.length === 1
        ? `「${sourcePrompts[0].name || sourceIdentifiers[0]}」`
        : `${sourcePrompts.length} 个条目`;
    const suffix = renamedCount.n ? `（${renamedCount.n} 个同名条目已自动改名）` : '';
    const verb = move ? '移动' : '复制';
    toastr.success(`已将${label}${verb}到预设「${targetName}」。${suffix}`);
}

// =====================================================================
// 初始化
// =====================================================================

function init() {
    const container = document.querySelector(PM_CONTAINER_SEL);
    if (!container) {
        console.warn('[preset-move-copy] 未找到提示词管理器容器，扩展不加载。');
        return;
    }
    if (container.dataset.pmcInited) return;
    container.dataset.pmcInited = '1';

    // 事件委托：只绑一次
    container.addEventListener('click', (event) => {
        // 多选勾选框
        const pick = event.target.closest(`.${PICK_CLASS}`);
        if (pick) {
            event.stopPropagation();
            const li = pick.closest('li[data-pm-identifier]');
            if (!li) return;
            const id = li.dataset.pmIdentifier;
            if (selectedIds.has(id)) selectedIds.delete(id);
            else selectedIds.add(id);
            syncPickState(pick, id);
            updateBatchBar();
            return;
        }

        // 单条移动/复制按钮
        const btn = event.target.closest(`.${BTN_CLASS}`);
        if (!btn) return;
        event.stopPropagation();
        const li = btn.closest('li[data-pm-identifier]');
        if (!li) return;
        openTransferPopup(li.dataset.pmIdentifier);
    });

    // 监听列表重建（每次 render 会清空重建），仅做按钮补缺
    const observer = new MutationObserver(() => {
        injectBatchBar();
        injectButtons();
    });
    observer.observe(container, { childList: true, subtree: true });

    injectBatchBar();
    injectButtons();
    console.log('[preset-move-copy] 预设提示词移动/复制已加载（含多选、分组支持）。');
}

// 幂等守卫：data/extensions 与 third-party 虚拟路径可能导致模块被执行两次，
// 确保委托、Observer 只绑定一份
if (window.__pmcMoveCopyLoaded) {
    console.warn('[preset-move-copy] 检测到重复加载，跳过。');
} else {
    window.__pmcMoveCopyLoaded = true;
    jQuery(() => {
        eventSource.on(event_types.APP_READY, init);
    });
}
