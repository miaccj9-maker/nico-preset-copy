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
const ANCHOR_CLASS = 'pmx-anchor';
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
// 按钮注入
// =====================================================================

/**
 * 遍历当前提示词列表，为缺少按钮的可移动条目注入按钮（只做「补缺」）
 */
function injectButtons() {
    if (!promptManager) return;
    const list = document.querySelector(PM_LIST_SEL);
    if (!list) return;

    const items = list.querySelectorAll('li[data-pm-identifier]');
    for (const li of items) {
        if (li.querySelector(`.${BTN_CLASS}`)) continue;

        const identifier = li.dataset.pmIdentifier;
        const prompt = oai_settings.prompts?.find(p => p && p.identifier === identifier);
        if (!isTransferable(prompt)) continue;

        const controls = li.querySelector('.prompt_manager_prompt_controls');
        if (!controls) continue;

        const btn = document.createElement('span');
        btn.className = `${BTN_CLASS} fa-solid fa-right-left fa-xs`;
        btn.title = '移动/复制到其他预设';
        controls.prepend(btn);
    }
}

// =====================================================================
// 弹窗：目标预设 + 分组 + 插入位置
// =====================================================================

/**
 * 渲染目标预设的位置列表（分组区块 + 拖拽锚点 + 点击选位）
 */
function renderPositionList(wrap, targetName, movingName) {
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

    // 锚点行（默认末尾、未分组）
    rowsHtml.push(`
        <li class="${ITEM_CLASS} ${ANCHOR_CLASS}">
            <span class="pmx-handle fa-solid fa-grip-vertical" title="拖动选择位置"></span>
            <span class="pmx-anchor-icon fa-solid fa-map-pin"></span>
            <span class="pmx-item-name">「${escapeHtml(movingName)}」插入到此处</span>
            <span class="pmx-anchor-group"></span>
        </li>
    `);

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

    wrap.innerHTML = `
        <ul class="${POSITION_LIST_CLASS}">${rowsHtml.join('')}</ul>
        ${orphanHtml ? `<ul class="${POSITION_LIST_CLASS} pmx-orphan-list">${orphanHtml}</ul>` : ''}
        <div class="pmx-hint">
            点击「⤓ 插此」或「📌 插入本组」选位，也可拖动 📌 锚点行；
            拖动条目可跨组移动，组归属按最终位置自动更新。
        </div>
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
    const refreshAnchorGroupLabel = () => {
        const anchor = mainList.querySelector(`.${ANCHOR_CLASS}`);
        if (!anchor) return;
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
    };

    mainList.addEventListener('click', (event) => {
        const anchor = mainList.querySelector(`.${ANCHOR_CLASS}`);
        if (!anchor) return;

        const groupInsert = event.target.closest('.pmx-group-insert');
        if (groupInsert) {
            event.stopPropagation();
            const hdr = groupInsert.closest(`.${GROUP_HEADER_CLASS}`);
            // 锚点移到本组结束行之前（组块末尾）
            const end = mainList.querySelector(
                `.${GROUP_END_CLASS}[data-group-id="${CSS.escape(hdr.dataset.groupId)}"]`,
            );
            if (end) end.before(anchor); else mainList.appendChild(anchor);
            refreshAnchorGroupLabel();
            refreshGroupCounts();
            return;
        }

        const here = event.target.closest('.pmx-here');
        if (here) {
            event.stopPropagation();
            const row = here.closest(`.${ITEM_CLASS}`);
            if (row && !row.classList.contains(ANCHOR_CLASS)) row.before(anchor);
            refreshAnchorGroupLabel();
            refreshGroupCounts();
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
            refreshAnchorGroupLabel();
            refreshGroupCounts();
        },
    });

    refreshGroupCounts();
    refreshAnchorGroupLabel();
    return model;
}

/**
 * 从弹窗 DOM 计算最终顺序与分组归属
 *
 * @returns {{ orderedIds: string[], anchorIndex: number,
 *            finalGroups: Array<{id:string, name:string, members:string[]}> }}
 */
function collectPositionResult(wrap, model) {
    const mainList = wrap.querySelector(`ul.${POSITION_LIST_CLASS}`);
    const metaById = new Map(model.groups.map(g => [g.id, g]));

    const orderedIds = [];
    const membersByGroup = new Map();
    let currentGroupId = null;
    let anchorIndex = null;
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
            anchorIndex = orderedIds.length;
            li.dataset.anchorGroup = currentGroupId || '';
            continue;
        }
        const pid = li.dataset.pmPid;
        if (!pid) continue;
        orderedIds.push(pid);
        if (currentGroupId) {
            if (!membersByGroup.has(currentGroupId)) membersByGroup.set(currentGroupId, []);
            membersByGroup.get(currentGroupId).push(pid);
        }
    }

    // 组标题出现顺序为准（含空组；同组多段时聚合到同一组）
    const finalGroups = [...new Set(groupOrder)].map(id => ({
        id,
        name: metaById.get(id)?.name || id,
        members: membersByGroup.get(id) || [],
    }));

    if (anchorIndex === null) anchorIndex = orderedIds.length;
    return { orderedIds, anchorIndex, finalGroups, anchorGroupId: mainList.querySelector(`.${ANCHOR_CLASS}`)?.dataset.anchorGroup || '' };
}

/**
 * 打开移动/复制弹窗
 */
async function openTransferPopup(identifier) {
    const sourcePrompt = oai_settings.prompts?.find(p => p && p.identifier === identifier);
    if (!sourcePrompt || !isTransferable(sourcePrompt)) return;

    const currentPresetName = oai_settings.preset_settings_openai;
    const targetNames = Object.keys(openai_setting_names).filter(n => n !== currentPresetName);

    if (targetNames.length === 0) {
        toastr.warning('没有其他预设可移动/复制。');
        return;
    }

    const container = document.createElement('div');

    const title = document.createElement('div');
    title.className = 'pmx-popup-title';
    title.innerHTML = `移动/复制「<b>${escapeHtml(sourcePrompt.name || identifier)}</b>」到：`;
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
        currentModel = renderPositionList(positionWrap, select.value, sourcePrompt.name || identifier)
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
        await transferPrompt(identifier, targetName, currentModel, positionResult, move);
    } catch (err) {
        console.error('[preset-move-copy]', err);
        toastr.error(err?.message || '移动/复制失败。');
    }
}

// =====================================================================
// 核心：移动 / 复制
// =====================================================================

async function transferPrompt(sourceIdentifier, targetName, model, positionResult, move) {
    const { orderedIds, anchorIndex, finalGroups, anchorGroupId } = positionResult;
    const targetIndex = openai_setting_names[targetName];
    if (targetIndex === undefined) throw new Error(`找不到目标预设「${targetName}」。`);

    const sourcePresetName = oai_settings.preset_settings_openai;
    const sourcePrompt = oai_settings.prompts.find(p => p && p.identifier === sourceIdentifier);
    if (!sourcePrompt) throw new Error('源提示词不存在。');

    // 深拷贝目标预设（内存缓存 → 改写 → 整体写回，保留目标预设全部字段）
    const targetPreset = structuredClone(openai_settings[targetIndex]);
    if (!Array.isArray(targetPreset.prompts)) targetPreset.prompts = [];

    // 深拷贝待转移提示词，并处理 identifier 冲突
    const movedPrompt = structuredClone(sourcePrompt);
    const existingIds = new Set(targetPreset.prompts.map(p => p && p.identifier));
    let renamed = false;
    if (existingIds.has(movedPrompt.identifier)) {
        movedPrompt.identifier = makeUniqueIdentifier(movedPrompt.identifier, existingIds);
        renamed = true;
    }
    targetPreset.prompts.push(movedPrompt);

    // 源条目在当前预设中的启用状态
    const sourceOrder = getGlobalOrder(oai_settings);
    const sourceRef = sourceOrder.find(r => r.identifier === sourceIdentifier);
    const movedEnabled = sourceRef ? !!sourceRef.enabled : false;

    // 按弹窗顺序重建全局 order，并在锚点处插入新条目
    const targetOrder = getGlobalOrder(targetPreset);
    const oldRefMap = new Map(targetOrder.map(r => [r.identifier, r]));
    const rebuilt = [];
    orderedIds.forEach((id, i) => {
        if (i === anchorIndex) rebuilt.push({ identifier: movedPrompt.identifier, enabled: movedEnabled });
        rebuilt.push(oldRefMap.get(id) ?? { identifier: id, enabled: false });
    });
    if (anchorIndex >= orderedIds.length) {
        rebuilt.push({ identifier: movedPrompt.identifier, enabled: movedEnabled });
    }
    // 保留未在排序列表中展示的悬空引用（数据不丢）
    for (const ref of targetOrder) {
        if (!orderedIds.includes(ref.identifier) && ref.identifier !== movedPrompt.identifier) rebuilt.push(ref);
    }
    const orderEntry = targetPreset.prompt_order.find(
        l => String(l.character_id) === String(getDummyId()),
    );
    orderEntry.order = rebuilt;

    // 重建分组数据：把新条目加入锚点所在组（锚点位置 = 锚点前一条目之后；
    // 锚点若在组内，需要把新 id 插到该组 members 的正确位置）
    if (model.format) {
        const groupsWithNew = finalGroups.map(g => ({ id: g.id, name: g.name, members: [...g.members] }));

        // 数据安全：弹窗只展示在全局 order 中存在的成员，原组数据里若引用了
        // 未在列表展示的条目（悬空/游离），原样保留在组末，不丢失引用
        const visibleIds = new Set(orderedIds);
        for (const g of groupsWithNew) {
            const orig = model.groups.find(x => x.id === g.id);
            if (!orig) continue;
            for (const id of orig.members) {
                if (!visibleIds.has(id) && !g.members.includes(id)) g.members.push(id);
            }
        }

        if (anchorGroupId) {
            const g = groupsWithNew.find(x => x.id === anchorGroupId);
            if (g) {
                // 锚点前的条目即插入位置参照；members 与 DOM 顺序一致，
                // 锚点之前、本组最后一个成员的位置
                const beforeIds = orderedIds.slice(0, anchorIndex);
                let insertAt = g.members.length;
                for (let i = beforeIds.length - 1; i >= 0; i--) {
                    const idx = g.members.indexOf(beforeIds[i]);
                    if (idx !== -1) { insertAt = idx + 1; break; }
                }
                // 若锚点前面没有本组成员（拖到组首），插到 0
                if (insertAt === g.members.length) {
                    const afterIds = orderedIds.slice(anchorIndex);
                    const firstInGroup = afterIds.find(id => g.members.includes(id));
                    if (firstInGroup !== undefined) insertAt = g.members.indexOf(firstInGroup);
                }
                g.members.splice(insertAt, 0, movedPrompt.identifier);
            }
        }
        writeGroups(targetPreset, model, groupsWithNew);
    }

    // 写盘目标预设
    await savePresetFile(targetName, targetPreset);
    openai_settings[targetIndex] = targetPreset;

    if (move) {
        // 从当前预设的 prompts 中移除
        const promptIdx = oai_settings.prompts.findIndex(p => p && p.identifier === sourceIdentifier);
        if (promptIdx !== -1) oai_settings.prompts.splice(promptIdx, 1);
        // 从所有顺序列表中移除引用
        for (const list of oai_settings.prompt_order || []) {
            if (!Array.isArray(list.order)) continue;
            for (let i = list.order.length - 1; i >= 0; i--) {
                if (list.order[i]?.identifier === sourceIdentifier) list.order.splice(i, 1);
            }
        }
        // 清理源预设分组中对该条目的引用
        const sourceModel = readGroups(oai_settings);
        if (sourceModel.format) {
            const sourceFinal = sourceModel.groups
                .map(g => ({ id: g.id, name: g.name, members: g.members.filter(id => id !== sourceIdentifier) }));
            writeGroups(oai_settings, sourceModel, sourceFinal);
        }

        // 写盘当前预设（与官方「更新预设」按钮一致，白名单 preset 体）
        const presetBody = getChatCompletionPreset(oai_settings);
        await savePresetFile(sourcePresetName, presetBody);
        const currentIndex = openai_setting_names[sourcePresetName];
        if (currentIndex !== undefined) Object.assign(openai_settings[currentIndex], presetBody);

        saveSettingsDebounced();
        promptManager?.render();
        const suffix = renamed ? '（目标预设已存在同名条目，已自动改名）' : '';
        toastr.success(`已将「${sourcePrompt.name || sourceIdentifier}」移动到预设「${targetName}」。${suffix}`);
    } else {
        const suffix = renamed ? '（目标预设已存在同名条目，已自动改名）' : '';
        toastr.success(`已将「${sourcePrompt.name || sourceIdentifier}」复制到预设「${targetName}」。${suffix}`);
    }
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
        const btn = event.target.closest(`.${BTN_CLASS}`);
        if (!btn) return;
        event.stopPropagation();
        const li = btn.closest('li[data-pm-identifier]');
        if (!li) return;
        openTransferPopup(li.dataset.pmIdentifier);
    });

    // 监听列表重建（每次 render 会清空重建），仅做按钮补缺
    const observer = new MutationObserver(() => injectButtons());
    observer.observe(container, { childList: true, subtree: true });

    injectButtons();
    console.log('[preset-move-copy] 预设提示词移动/复制已加载（含分组支持）。');
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
