# 《病毒树》(The Plague Tree) 简体中文汉化层

本目录是《病毒树》的**独立汉化层**，通过「加载期拦截 + 运行时词典替换」实现汉化，
**不改动任何游戏源码**（仅 `index.html` 增加 3 行接入）。

## 文件说明

| 文件 | 作用 |
|---|---|
| `zh_CN.js` | 简体中文词典（`window.PLT_I18N`），由 `tools/build_dict.js` 生成，**请勿手改** |
| `i18n.js` | 汉化引擎（拦截 addLayer / run / doPopup / Vue.component，运行时替换文本） |

## 工作原理

基于 The-Modding-Tree 引擎，游戏内容定义在 `js/layers.js`（图层、升级、成就、里程碑等）。
汉化层在游戏脚本加载后运行：

1. **包装 `addLayer`** —— 图层数据（名称/资源/升级/成就/里程碑/可购买项/子标签页）在注册时即翻译；
   函数型字段包一层，求值后翻译返回值。
2. **包装 `run()` / `gridRun()` / `doPopup()`** —— 所有经它们渲染的 `v-html` 文本（含动态拼串）。
3. **包装 `Vue.component()`** —— 对组件模板里的静态英文做定点补丁（如「设置页」「成就页」的固定文案）。
4. **包装 `alert/confirm/prompt`** —— 浏览器原生弹窗的正文。
5. **MutationObserver** —— 兜底翻译运行期插入的文本节点（如 `index.html` 静态文案、更新日志）。
6. **设置页注入「语言：中文 / English」按钮**，选择存 `localStorage`，切换后自动刷新。

## 词典结构

`zh_CN.js` 里分两桶：

- **exact**：整串精确匹配（层数据里的静态文案、完整句子）。
- **fragment**：子串替换（动态拼串的静态片段、标签内文字）。

匹配器把两桶键按长度降序合成一条正则，一次替换；纯单词键自动加 `\b` 边界；
「资源路径 / id 形态 token」先掩码再还原，避免误译样式与路径。

## 语言切换

- 设置页「语言」按钮切换；URL 参数 `?lang=en` / `?lang=zh-CN` 也可切换（优先于 localStorage）。
- 英文模式（`en`）下引擎整体关闭，界面与原版一致。

## 维护须知

上游更新后，重跑 `tools/` 下的提取 → 翻译 → 合并脚本即可；`zh_CN.js` 永远由脚本生成，不手改。

- `tools/extract.js` —— 源码 → 运行态字符串清单
- `tools/worklist.js` —— 过滤模板/CSS/代码 → 待译清单
- `tools/zip.js` —— 对照中英文 → exact/fragment 两桶
- `tools/build_dict.js` —— 合并 → `localization/zh_CN.js`（含基础词汇表与更新日志补丁）
- `tools/coverage.js` —— 无头浏览器全层遍历，输出英文残留审计
- `tools/probe.js` —— 单页截图 / 单点探测

## 已知取舍

1. **缩写（CTNA / CRNA / RNA / mRNA / MMNA / PrPres / AnTNA / UBV 等）不译**，它们是公式、
   价格与按钮里的符号，翻译反而看不清。术语表已统一此口径。
2. **游戏专名与作品名保留**：The Plague Tree、The Modding Tree、The Prestige Tree、Discord，
   以及作者起的「玩梗」成就名（`GAS GAS`、`'23R0' D34TH5`、`CO.RO.NA.` 等）按术语表口径处理。
3. **浏览器自带 UI 无法汉化**：对话框的「确定/取消」按钮、地址栏、右键菜单由浏览器绘制，
   页面只能控制 `alert/confirm/prompt` 的正文和标签页标题。
