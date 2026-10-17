# 预设提示词移动/复制（preset-move-copy）

SillyTavern 1.18 前端扩展。模仿世界书「移动/复制条目到其他世界书」，为
**Chat Completion → 提示词管理器（Prompt Manager）**里的提示词条目增加跨预设的
移动 / 复制能力，支持把条目放进目标预设的**分组（合并组）**。

## 功能

- 每个可移动的提示词条目右侧出现 `fa-right-left` 按钮（与世界书同款图标）
- 点击后弹窗：
  - **选目标预设**：下拉列出全部 Chat Completion 预设，自动排除当前预设
  - **选位置**：目标预设的提示词顺序按分组展示，三种方式任选：
    - 点击任意行的「⤓ 插此」——把锚点插到该行之前（手机端首选，无需拖拽）
    - 点击分组标题上的「📌 插入本组」——直接放到该组末尾
    - 拖动 📌 锚点行，或直接拖动目标预设原有条目跨组重排（jQuery UI sortable，
      酒馆自带 touch-punch，手机触摸可拖）
  - 锚点行实时显示当前归属（「未分组」或「归组：xxx」）
- **分组（合并组）支持**，自动兼容两种主流分组数据格式：
  - **柏宝箱 ST-BaiBai-Tools**：`extensions.baibaiToolkit.presetPromptGroups`
    （groups/prompts，保留组的 order / collapsed / enabled 等元数据）
  - **preset-transfer 条目分组**：`extensions.entryGrouping`
    （memberIdentifiers，保留组的 mode）
  - 目标预设没有分组时：保持平铺，不写入任何分组字段
  - 分组用「标题行 + 结束行」钉死边界，未归组条目即使紧邻组块也不会被误收编；
    不拖动时确认结果与原分组数据完全一致
  - 空组也会展示，可直接放入条目
- **移动**：从当前预设删除并写入目标预设，两个预设文件都会即时落盘；
  源预设分组中对该条目的引用会同步清理
- **复制**：当前预设不动，条目复制到目标预设
- identifier 冲突时自动改名（`<原id>_copy`、`_copy2`…），不会覆盖目标预设的同名条目，并弹出提示
- 启用/禁用状态随条目一起带过去
- 系统提示词（main / nsfw / jailbreak / 聊天历史 / 角色卡锚点等）与扩展注入条目
  不显示按钮，防止误删内置结构（与原生「移除」按钮的允许范围一致）
- 目标预设里「存在但未加入顺序」的游离条目仅展示提示，不会被改动

## 生效方式

- 目标预设：直接写 JSON 文件 + 同步内存缓存，切换到该预设即可看到结果
- 移动时源预设：与官方「更新预设」按钮相同的白名单写盘方式，随后刷新当前列表
- 预设文件路径：`data/<用户>/OpenAI Settings/<预设名>.json`
- 分组数据路径：预设 JSON 的 `extensions.entryGrouping` 或
  `extensions.baibaiToolkit.presetPromptGroups`

## 轻量设计

- 一个 MutationObserver 只监听提示词管理器容器，仅在列表重建后做「补缺」注入
- 一次事件委托，无定时器、无轮询
- 分组解析只在弹窗打开、切换目标预设时各做一次
- 弹窗关闭后不残留任何状态

## 手机端

- 弹窗 96vw 铺满、列表加高等触控适配
- 点击「插此 / 插入本组」即可完成选位，不依赖拖拽
- 拖拽由 jQuery UI + touch-punch 提供，触摸可用

## 文件

- `manifest.json` — 扩展清单
- `index.js` — 全部逻辑
- `style.css` — 弹窗与按钮样式（含移动端媒体查询）

## 兼容性

- SillyTavern 1.18.x，Chat Completion（global 提示词顺序，dummyId 100001）
- 柏宝箱分组、preset-transfer 分组；无分组预设（平铺）照常可用
- 仅前端，无服务端依赖，使用酒馆自带的 `/api/presets/save` 接口
