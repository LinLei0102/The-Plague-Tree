// ============================================================================
//  The Plague Tree — 简体中文汉化层  (localization/i18n.js)
//  ---------------------------------------------------------------------------
//  设计参考「天体增量树 汉化」：不修改任何游戏源码，采用
//  「加载期拦截 + 运行时词典替换」，上游更新时可干净合并。
//
//  工作原理（TMT / The-Modding-Tree 引擎）：
//    1. 包装 addLayer —— 图层数据（名称/升级/成就/里程碑/可点击项/信息框/
//       子标签页内容）在注册时即被翻译；函数型字段包一层，求值后翻译返回值。
//    2. 包装 run() / gridRun() —— 所有经它们渲染的 v-html 文本（含动态拼串）。
//    3. 包装 doPopup() —— 弹窗标题与正文。
//    4. 包装 Vue.component() —— 只做少量「模板字面量」定点补丁（组件模板里的
//       静态英文不经过任何 JS 函数，只能改模板）。
//    5. MutationObserver —— 兜底翻译运行期插入的文本节点（index.html 静态文案等）。
//    6. 设置页注入「语言：中文 / English」按钮，选择存 localStorage。
//
//  词典文件：localization/zh_CN.js （window.PLT_I18N）
// ============================================================================
(function () {
    "use strict";

    // ------------------------------------------------------------------
    // 0. 语言状态
    // ------------------------------------------------------------------
    var LS_KEY = "plaguetree_i18n_lang";
    var lang = "zh-CN";
    try { lang = localStorage.getItem(LS_KEY) || "zh-CN"; } catch (e) { /* ignore */ }
    // URL 参数 ?lang=en / ?lang=zh-CN：便于分享与临时切换（优先于 localStorage）
    try {
        var qm = /[?&]lang=(en|zh-CN)/.exec(location.search);
        if (qm) { lang = qm[1]; localStorage.setItem(LS_KEY, lang); }
    } catch (e) { /* ignore */ }

    var DICTS = window.PLT_I18N || {};
    var active = DICTS[lang] || DICTS["zh-CN"] || { exact: {}, fragment: {} };
    var exact = active.exact || {};
    var fragment = active.fragment || {};
    var ENABLED = (lang === "zh-CN");

    // ------------------------------------------------------------------
    // 1. 词典匹配器：所有 key 按长度降序合成一条正则，一次替换
    //    - 纯英文单词键自动加 \b 边界
    //    - 追加「HTML 标签」分支，整段标签原样保留（属性名/样式/路径不被误译）
    // ------------------------------------------------------------------
    var masterRe = null;
    var masterTest = null;
    var masterMap = {};

    function escapeRe(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    function isPureWord(s) {
        return /^[A-Za-z]+$/.test(s);
    }

    // 纯单词键的「右向守卫」：后面紧跟代码符号时不匹配
    //   style='width:69px'  → 不动（CSS 声明）
    //   <img width='100'>   → 不动（HTML 属性）
    //   {'width': 1}        → 不动（JS 键）
    //   "Cost:" / "Cost:<br>" → 照常译（冒号后不是值字符，属于文案）
    var WORD_GUARD_AFTER = "(?![\\w$'\"])(?![=])(?!:[\\w#.\\-])";

    function buildMatcher() {
        var seen = {}, keys = [], k, i;
        // 整串词条与片段词条都进入正则：
        //   exact 只是「整串相等时优先命中」，但在拼接串里（"0.000 Water"）也需要它来做子串替换。
        // 副作用（"The Prestige Tree" 被 "Prestige" 误译）由 translate() 里的
        // 「已含中文就不再走子串替换」规则挡住。
        for (k in exact) if (!seen[k]) { seen[k] = 1; keys.push(k); }
        for (k in fragment) if (!seen[k]) { seen[k] = 1; keys.push(k); }
        keys.sort(function (a, b) { return b.length - a.length; });
        var parts = [];
        masterMap = {};
        for (i = 0; i < keys.length; i++) {
            k = keys[i];
            masterMap[k] = (k in exact) ? exact[k] : fragment[k];
            parts.push(isPureWord(k)
                ? ("\\b" + escapeRe(k) + "\\b" + WORD_GUARD_AFTER)
                : escapeRe(k));
        }
        if (parts.length) {
            masterRe = new RegExp("(" + parts.join("|") + ")|(<[^>]*>)", "g");
            masterTest = new RegExp(parts.join("|"));
        }
    }
    buildMatcher();

    // 译文集合：若输入本身就是某条词典的译文，直接返回 —— 保证翻译幂等，
    // 避免「译文里恰好含英文术语」时被再次替换（如 "…Discord 服务器" → "…服务器 服务器"）
    var OUTPUTS = (function () {
        var s = {};
        for (var k in exact) if (typeof exact[k] === "string") s[exact[k]] = 1;
        for (var k2 in fragment) if (typeof fragment[k2] === "string") s[fragment[k2]] = 1;
        return s;
    })();

    // ------------------------------------------------------------------
    // 2. 保护层：资源路径 / id 形态 token 先掩码，翻译后还原
    // ------------------------------------------------------------------
    var PATH_RE = /\b(?:resources|Savebank|css|js|music|fragments|docs|data)\/[^\s'"<>()]*/g;
    var ID_SCAN = /[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+/g;

    function idShape(s) {
        return /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/.test(s);
    }
    function stripPunctDash(s) {
        return s.replace(/^\s*-\s+/, "").replace(/\s+-\s?/g, " ");
    }
    // 「id 形态但其实是显示名」白名单：该 token 出现在某条词典 key 里，
    //   ① 该 key 的译文完全译出（剥掉标签/标点短横线后不含 '-'），或
    //   ② 译文里原样保留了该 token（有意保留英文的术语）
    var ID_SAFE = (function () {
        var safe = {};
        function harvest(k, v) {
            if (typeof v !== "string") return;
            var clean = v.replace(/<[^>]*>/g, "");
            var m = String(k).match(ID_SCAN);
            if (!m) return;
            var cleanOk = stripPunctDash(clean).indexOf("-") < 0;
            for (var i = 0; i < m.length; i++) {
                var tok = m[i];
                if (cleanOk || clean.indexOf(tok) >= 0) safe[tok] = 1;
            }
        }
        for (var k in exact) harvest(k, exact[k]);
        for (var k2 in fragment) harvest(k2, fragment[k2]);
        return safe;
    })();

    // ------------------------------------------------------------------
    // 3. 翻译核心
    // ------------------------------------------------------------------
    var cache = new Map();
    var CACHE_MAX = 8000;

    // 少量「选项值」整串映射：这些词只在设置页作为取值出现（off/on/…），
    // 单独查表比丢进正则安全（"on" 当子串会误伤 "on the left" 之类）
    var SPECIAL = { off: "关", on: "开", ultra: "极强", earthquake: "地震" };

    function translate(str) {
        if (!ENABLED || typeof str !== "string" || str.length < 2) return str;
        if (SPECIAL[str] !== undefined) return SPECIAL[str];
        if (/^[A-Za-z0-9]$/.test(str)) return str;
        if (OUTPUTS[str] === 1) return str;                 // 已是译文，幂等返回
        if (cache.has(str)) return cache.get(str);
        var out;
        if (Object.prototype.hasOwnProperty.call(exact, str)) {
            var ev = exact[str];
            out = (idShape(str) && typeof ev === "string" && ev.indexOf("-") >= 0) ? str : ev;
        } else if (PROTECTED[str] === 1) {
            // 模板补丁的产物（如「The Prestige Tree 由 Jacorb 与 Aarex 制作」）：
            // 里面的英文专名不能再被子串词条改写
            out = str;
        } else {
            var guards = [];
            var masked = str.replace(PATH_RE, function (m) {
                guards.push(m);
                return "\u0001" + (guards.length - 1) + "\u0001";
            });
            masked = masked.replace(ID_SCAN, function (m) {
                if (ID_SAFE[m] === 1) return m;
                guards.push(m);
                return "\u0001" + (guards.length - 1) + "\u0001";
            });
            if (masterTest && masterTest.test(masked)) {
                out = masked.replace(masterRe, function (m, key, tag) {
                    if (tag !== undefined) return tag;
                    return masterMap[m];
                });
            } else {
                out = masked;
            }
            if (guards.length) out = out.replace(/\u0001(\d+)\u0001/g, function (_, i) { return guards[+i]; });
        }
        // 时间单位：数字前缀限定，避免误伤普通英文（ms 必须排在 s 之前）
        out = out
            .replace(/(\d+(?:\.\d+)?)\s?ms(?![\w])/g, "$1毫秒")
            .replace(/(\d+(?:\.\d+)?)\s?y(?![\w])/g, "$1年")
            .replace(/(\d+(?:\.\d+)?)\s?d(?![\w])/g, "$1天")
            .replace(/(\d+(?:\.\d+)?)\s?h(?![\w])/g, "$1小时")
            .replace(/(\d+(?:\.\d+)?)\s?m(?![\w])/g, "$1分")
            .replace(/(\d+(?:\.\d+)?)\s?s(?![\w])/g, "$1秒")
            .replace(/(\d+(?:\.\d+)?)\s?\/s(?![\w])/g, "$1/秒");
        if (cache.size >= CACHE_MAX) cache.clear();
        cache.set(str, out);
        return out;
    }

    // ------------------------------------------------------------------
    // 4. 函数包装：保留原函数，仅翻译其字符串返回值
    // ------------------------------------------------------------------
    function wrapTextFn(fn) {
        if (typeof fn !== "function" || fn.__pltWrapped) return fn;
        var orig = fn;
        var wrapped = function () {
            var r = orig.apply(this, arguments);
            return (typeof r === "string") ? translate(r) : r;
        };
        wrapped.__pltWrapped = true;
        wrapped.__pltOrig = orig;
        return wrapped;
    }
    function translateValue(v) {
        if (typeof v === "string") return translate(v);
        if (typeof v === "function") return wrapTextFn(v);
        return v;
    }

    // ------------------------------------------------------------------
    // 5. 图层数据结构 —— 只翻「显示字段」，绝不碰 id / 样式 / 代码
    // ------------------------------------------------------------------
    // 层对象自身的显示字段。注意 resource / baseResource 是**层级**字段
    // （main-display / resource-display / 树节点 tooltip 都会拼它），不是集合项字段。
    var LAYER_FIELDS = ["name", "tooltip", "tooltipLocked", "subtitle", "effectDescription",
        "startText", "resource", "resourceSingular", "baseResource", "baseSingular",
        "pointsName", "pointsNameSingular"];
    var ITEM_FIELDS = [
        "name", "title", "description", "desc", "tooltip", "tooltipLocked",
        "display", "effectDisplay", "fullDisplay", "body", "text", "label",
        "requirementDescription", "effectDescription", "challengeDescription",
        "goalDescription", "rewardDescription", "unlockedDescription",
        "currencyDisplayName", "resource", "baseResource",
        "respecText", "masterButtonText", "sellOneText", "sellAllText", "masterButtonText"
    ];
    var COLLECTIONS = ["upgrades", "buyables", "milestones", "challenges",
        "achievements", "clickables", "grid", "bars", "infoboxes", "sublayers"];

    function translateItem(obj) {
        if (!obj || typeof obj !== "object") return;
        for (var i = 0; i < ITEM_FIELDS.length; i++) {
            var f = ITEM_FIELDS[i];
            if (obj[f] !== undefined) obj[f] = translateValue(obj[f]);
        }
    }

    // tabFormat / content 数组：[组件名, 载荷...]
    // 只翻文本型组件的 payload[1]；容器型组件递归其数组载荷；其余（id、数字）不动
    var TEXT_TYPES = { "display-text": 1, "raw-html": 1, "text": 1, "info": 1, "tooltip": 1 };

    function translateFormatArray(arr) {
        if (!Array.isArray(arr)) return;
        for (var i = 0; i < arr.length; i++) {
            var item = arr[i];
            if (!Array.isArray(item) || typeof item[0] !== "string") continue;
            if (TEXT_TYPES[item[0]]) {
                if (item[1] !== undefined) item[1] = translateValue(item[1]);
            } else {
                for (var j = 1; j < item.length; j++) {
                    if (Array.isArray(item[j])) translateFormatArray(item[j]);
                }
            }
        }
    }

    function translateMicrotabs(mt) {
        if (!mt || typeof mt !== "object") return;
        for (var grp in mt) {
            var tabs = mt[grp];
            if (!tabs || typeof tabs !== "object") continue;
            for (var name in tabs) {
                var tab = tabs[name];
                if (!tab || typeof tab !== "object") continue;
                // 键名是 player.subtabs 的存储值，**不能改名**；把译文注入 title，
                // 由 tab-buttons 模板读 title（见下方 Vue.component 补丁）
                var zh = translate(name);
                if (zh !== name && tab.title === undefined) tab.title = zh;
                if (tab.title !== undefined) tab.title = translateValue(tab.title);
                if (tab.content) translateFormatArray(tab.content);
            }
        }
    }

    function translateLayerData(d) {
        if (!d || typeof d !== "object") return;
        var i, f;
        for (i = 0; i < LAYER_FIELDS.length; i++) {
            f = LAYER_FIELDS[i];
            if (d[f] !== undefined) d[f] = translateValue(d[f]);
        }
        for (i = 0; i < COLLECTIONS.length; i++) {
            var col = d[COLLECTIONS[i]];
            if (!col || typeof col !== "object") continue;
            for (var id in col) translateItem(col[id]);
        }
        if (d.hotkeys) {
            for (var hk in d.hotkeys) {
                var h = d.hotkeys[hk];
                if (h && typeof h === "object" && h.description !== undefined) h.description = translateValue(h.description);
            }
        }
        if (d.microtabs) translateMicrotabs(d.microtabs);
        if (d.midsection) translateFormatArray(d.midsection);
        if (d.tabFormat) {
            if (Array.isArray(d.tabFormat)) translateFormatArray(d.tabFormat);
            else if (typeof d.tabFormat === "object") {
                for (var sub in d.tabFormat) {
                    var t = d.tabFormat[sub];
                    if (!t || typeof t !== "object") continue;
                    var zh = translate(sub);
                    if (zh !== sub && t.title === undefined) t.title = zh;
                    if (t.title !== undefined) t.title = translateValue(t.title);
                    if (t.content) translateFormatArray(t.content);
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // 6. Hook: addLayer —— 图层注册时翻译
    // ------------------------------------------------------------------
    var origAddLayer = window.addLayer;
    if (typeof origAddLayer === "function") {
        window.addLayer = function (layerName, layerData, tabLayers) {
            try { translateLayerData(layerData); }
            catch (e) { console.warn("[PLTI18N] layer '" + layerName + "' translate failed", e); }
            return origAddLayer(layerName, layerData, tabLayers);
        };
    } else {
        console.warn("[PLTI18N] addLayer 未找到，汉化层可能失效");
    }

    // ------------------------------------------------------------------
    // 7. Hook: run() / gridRun() / doPopup()
    // ------------------------------------------------------------------
    function hookRuntime() {
        if (typeof window.run === "function" && !window.__pltRunHooked) {
            window.__pltRunHooked = true;
            var origRun = window.run;
            window.run = function (func, target, args) {
                var r = origRun(func, target, args);
                return (typeof r === "string") ? translate(r) : r;
            };
        }
        if (typeof window.gridRun === "function" && !window.__pltGridHooked) {
            window.__pltGridHooked = true;
            var origGrid = window.gridRun;
            window.gridRun = function (layer, func, data, id) {
                var r = origGrid(layer, func, data, id);
                return (typeof r === "string") ? translate(r) : r;
            };
        }
        if (typeof window.doPopup === "function" && !window.__pltPopupHooked) {
            window.__pltPopupHooked = true;
            var origPopup = window.doPopup;
            window.doPopup = function (type, text, title, timer, color, image) {
                if (typeof text === "string") arguments[1] = translate(text);
                if (typeof title === "string" && title !== "" ) arguments[2] = translate(title);
                else if (title === "" || title === undefined) {
                    // 源码里空标题会落到默认英文标题，这里补上译文
                    arguments[2] = translate(type === "achievement" ? "Achievement Unlocked!"
                        : type === "challenge" ? "Challenge Complete" : "Something Happened?");
                }
                return origPopup.apply(this, arguments);
            };
        }
    }

    // ------------------------------------------------------------------
    // 7.5 Hook: alert() / confirm() / prompt() —— 浏览器原生对话框
    //    对话框由浏览器绘制，但**正文文本是页面传进去的**，所以可以翻译；
    //    对话框上的「确定 / 取消」按钮属于浏览器界面，跟随浏览器语言，页面无法改。
    //    prompt 的第二个参数（默认输入值，如重置确认口令）是代码用的字面量，不译。
    // ------------------------------------------------------------------
    function hookDialogs() {
        ["alert", "confirm", "prompt"].forEach(function (name) {
            var orig = window[name];
            if (typeof orig !== "function" || orig.__pltHooked) return;
            var wrapped = function (msg) {
                var args = Array.prototype.slice.call(arguments);
                if (typeof args[0] === "string") args[0] = translate(args[0]);
                return orig.apply(window, args);
            };
            wrapped.__pltHooked = true;
            window[name] = wrapped;
        });
    }

    // ------------------------------------------------------------------
    // 8. Hook: Vue.component —— 模板定点补丁
    //    组件模板里的静态英文不经过任何会返回字符串的函数，只能改模板字面量。
    //    注意：只替换「模板里的纯文本段」，不碰 {{ }} 与 v-bind 表达式。
    // ------------------------------------------------------------------
    var TEMPLATE_PATCH = {
        // 微标签页 / 主标签页按钮：让 title 优先于键名（键名是存档里的 id，不能改）
        "tab-buttons": [
            [">{{tab}}</button>", ">{{data[tab].title ? data[tab].title : tab}}</button>"]
        ],
        // 顶部信息条（overlay-head 模板里的静态英文）
        "overlay-head": [
            ["You have ", "你拥有 "],
            ["Offline Time: ", "离线时间："],
            ["Dev Speed: ", "开发速度："],
            ["Current endgame: ", "当前终局："]
        ],
        "main-display": [
            ["You have ", "你拥有 "]
        ],
        "resource-display": [
            ["You have made a total of ", "累计获得 "],
            ["You have ", "你拥有 "],
            ["You are gaining ", "你每秒获得 "],
            [" per second", ""],
            ["Your best ", "你的最佳 "],
            [" is ", " 为 "]
        ],
        "upgrade": [
            ["<br>Currently: ", "<br>当前："],
            ["<br><br>Cost: ", "<br><br>花费："]
        ],
        "challenge": [
            ["Goal:  ", "目标： "],
            ["Reward: ", "奖励："],
            ["Currently: ", "当前："]
        ],
        "achievement": [
            ["You did it!", "你做到了！"],
            ["'LOCKED'", "'已锁定'"]
        ],
        "respec-button": [
            ["Respec", "洗点"],
            ["Disable respec confirmation", "禁用洗点确认"]
        ],
        "master-button": [
            ["Click me!", "点我！"]
        ],
        "sell-one": [["Sell One", "出售 1 个"]],
        "sell-all": [["Sell All", "全部出售"]],
        "options-tab": [
            [">Save<", ">保存<"],
            ["Autosave: ", "自动保存："],
            ["HARD RESET", "硬重置"],
            ["Export to clipboard", "导出到剪贴板"],
            [">Import<", ">导入<"],
            ["Import save from clipboard", "从剪贴板导入存档"],
            ["Export save to file", "导出存档到文件"],
            ["Import save from file", "从文件导入存档"],
            ["Action Mode (Not recommended on mobile): ", "操作模式（不推荐手机端）："],
            // 选项值是内部 id（off/on/ultra/…），用 $plt 走整串词典，避免直接改文案
            ["{{ getActionMode() }}", "{{ $plt(getActionMode()) }}"],
            ["{{ getThemeName() }}", "{{ $plt(getThemeName()) }}"],
            ["{{ getNotationName() }}", "{{ $plt(getNotationName()) }}"],
            ["{{ MS_DISPLAYS[MS_SETTINGS.indexOf(options.msDisplay)]}}", "{{ $plt(MS_DISPLAYS[MS_SETTINGS.indexOf(options.msDisplay)]) }}"],
            ["{{ player.notation }}", "{{ $plt(player.notation) }}"],
            ["Offline Prod: ", "离线产出："],
            ["Theme: ", "主题："],
            ["Show Milestones: ", "显示里程碑："],
            ["High-Quality Tree: ", "高质量树："],
            ["Completed Challenges: ", "已完成挑战："],
            ["Single-Tab Mode: ", "单标签模式："],
            ["CTRL-Click to Toggle Tooltips: ", "Ctrl+点击切换提示框："],
            ["Notation: ", "记数法："],
            ["Show Milestone Popups: ", "显示里程碑弹窗："],
            ["?\"ON\":\"OFF\"", "?\"开\":\"关\""],
            ["?\"HIDDEN\":\"SHOWN\"", "?\"隐藏\":\"显示\""],
            ["?\"ALWAYS\":\"AUTO\"", "?\"总是\":\"自动\""],
            // 语言切换按钮：设置页没有可挂载的容器 id，只能改模板末尾的 </table>
            ["</table>",
                "<tr><td colspan=\"3\"><button class=\"opt\" onclick=\"PLTI18N.toggle()\">" +
                "<span>语言：中文（点此切换 English）</span></button></td></tr></table>"]
        ],
        "info-tab": [
            ["Made by ", "作者："],
            ["The Prestige Tree made by Jacorb and Aarex", "The Prestige Tree 由 Jacorb 与 Aarex 制作"],
            [" by Acamaeda and FlamemasterNXF", "，作者 Acamaeda 与 FlamemasterNXF"],
            [">Changelog<", ">更新日志<"],
            ["Toggle Shift", "切换 Shift"],
            ["Time Played: ", "游戏时长："],
            ["<h3>Hotkeys</h3>", "<h3>快捷键</h3>"],
            ["Main Prestige Tree server", "主 Prestige Tree 服务器"]
        ]
    };

    // 模板补丁产物集合：这些字符串是「已成型的译文」，translate() 直接原样返回，
    // 免得其中的英文专名（Prestige Tree / The Modding Tree …）再被子串词条改写
    var PROTECTED = (function () {
        var s = {};
        for (var c in TEMPLATE_PATCH) {
            var rules = TEMPLATE_PATCH[c];
            for (var i = 0; i < rules.length; i++) s[rules[i][1]] = 1;
        }
        return s;
    })();

    function patchTemplate(name, tpl) {
        var rules = TEMPLATE_PATCH[name];
        if (tpl.indexOf("%LANG%") >= 0) {
            tpl = tpl.split("%LANG%").join(ENABLED ? "语言：中文（点此切换 English）" : "Language: English (click for 中文)");
        }
        if (rules) {
            for (var i = 0; i < rules.length; i++) {
                tpl = tpl.split(rules[i][0]).join(rules[i][1]);
            }
        }
        return tpl;
    }

    if (window.Vue && typeof window.Vue.component === "function") {
        var origComponent = window.Vue.component;
        window.Vue.component = function (name, options) {
            // 注意：Vue.component(name) 也是取值方式，此时 options 为 undefined
            if (typeof name === "string" && options && typeof options.template === "string" && ENABLED) {
                try { options.template = patchTemplate(name, options.template); }
                catch (e) { console.warn("[PLTI18N] template patch '" + name + "' failed", e); }
            }
            return origComponent.apply(this, arguments);
        };
    }

    // Vue 模板里可直接调用的翻译助手：设置页那些「值型插值」
    // （{{ getActionMode() }} 等）用它走整串词典，避免去改选项 id
    if (window.Vue && window.Vue.prototype) window.Vue.prototype.$plt = translate;

    // ------------------------------------------------------------------
    // 9. 兜底：DOM 文本节点观察器
    //    处理 index.html 静态文案、运行期拼接插入的文本等
    // ------------------------------------------------------------------
    var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, CODE: 1, PRE: 0 };

    function translateTextNode(node) {
        var t = node.nodeValue;
        if (!t || !/[A-Za-z]{2}/.test(t)) return;
        if (node.__pltDone === t) return;
        var zh = translate(t);
        // 源码里跨行缩进、带首尾空白的文案（index.html 的 Discord 链接、changelog 每行后跟的
        // <br> 前空格等）会带一串换行 / 制表符 / 尾随空格，词典键是压平后的形态，
        // 这里依次尝试：压平空白 → 压平并去首尾空白
        if (zh === t && /\s{2,}|\n|^\s|\s$/.test(t)) {
            var flat = t.replace(/\s+/g, " ");
            var z2 = translate(flat);
            if (z2 !== flat) zh = z2;
            else {
                var tr = flat.trim();
                if (tr !== flat) {
                    var z3 = translate(tr);
                    if (z3 !== tr) zh = z3;
                }
            }
        }
        if (zh !== t) {
            node.__pltDone = zh;      // 记录「我们自己写进去的值」，防止自己触发自己
            node.nodeValue = zh;
        } else {
            node.__pltDone = t;
        }
    }

    function walkDom(root) {
        if (!root) return;
        if (root.nodeType === 3) { translateTextNode(root); return; }
        if (root.nodeType !== 1) return;
        if (SKIP_TAGS[root.tagName] === 1) return;
        var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        var n;
        while ((n = tw.nextNode())) {
            var p = n.parentNode;
            if (p && SKIP_TAGS[p.tagName] === 1) continue;
            translateTextNode(n);
        }
    }

    function startDomHook() {
        walkDom(document.body);
        var mo = new MutationObserver(function (muts) {
            for (var i = 0; i < muts.length; i++) {
                var m = muts[i];
                if (m.type === "characterData") {
                    if (m.target.__pltDone !== m.target.nodeValue) translateTextNode(m.target);
                } else if (m.type === "childList") {
                    for (var j = 0; j < m.addedNodes.length; j++) walkDom(m.addedNodes[j]);
                }
            }
        });
        mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    // ------------------------------------------------------------------
    // 10. 语言切换
    // ------------------------------------------------------------------
    function setLanguage(l) {
        try { localStorage.setItem(LS_KEY, l); } catch (e) { /* ignore */ }
        location.reload();
    }

    // 给设置页注入语言按钮（挂到 #options-tab 的 table 后面）
    function injectLanguageButton() {
        try {
            var tab = document.getElementById("options-tab");
            if (!tab || tab.__pltLang) return;
            var tbl = tab.querySelector("table");
            if (!tbl) return;
            tab.__pltLang = 1;
            var row = document.createElement("tr");
            var td = document.createElement("td");
            td.setAttribute("colspan", "3");
            var btn = document.createElement("button");
            btn.className = "opt";
            btn.textContent = lang === "zh-CN" ? "语言：中文（点击切换为 English）" : "Language: English (click for 中文)";
            btn.onclick = function () { setLanguage(lang === "zh-CN" ? "en" : "zh-CN"); };
            td.appendChild(btn);
            row.appendChild(td);
            tbl.querySelector("tbody") ? tbl.querySelector("tbody").appendChild(row) : tbl.appendChild(row);
        } catch (e) { /* ignore */ }
    }

    // ------------------------------------------------------------------
    // 11. 启动
    // ------------------------------------------------------------------
    window.PLTI18N = {
        t: translate,
        lang: function () { return lang; },
        toggle: function () { setLanguage(lang === "zh-CN" ? "en" : "zh-CN"); },
        stats: function () {
            var n = 0, k;
            for (k in exact) n++;
            for (k in fragment) n++;
            return { exact: Object.keys(exact).length, fragment: Object.keys(fragment).length, total: n, enabled: ENABLED };
        }
    };

    // 接管标签页标题（游戏在 utils.js 里会把它设成英文 modInfo.name）
    function applyTitle() {
        try {
            var want = ENABLED ? "病毒树 The Plague Tree" : "The Plague Tree";
            if (document.title !== want) document.title = want;
        } catch (e) { /* ignore */ }
    }

    function boot() {
        hookRuntime();
        hookDialogs();
        // 标签页标题：原版 index.html 没有 <title>，且 js/utils.js:343 会写
        // `document.title = modInfo.name`（纯英文）。标题属于浏览器窗体文字，
        // 但内容由页面决定，所以可以本地化 —— 在游戏加载完成后接管一次。
        applyTitle();
        startDomHook();
        injectLanguageButton();
        setInterval(function () { hookRuntime(); injectLanguageButton(); applyTitle(); }, 500);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
    // run()/doPopup() 在 utils.js 之后才定义，这里补一次
    setTimeout(hookRuntime, 0);
    setTimeout(hookRuntime, 200);
    hookDialogs();
})();
