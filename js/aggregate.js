// =====================================
// WDTV 跨源同名聚合（零依赖纯函数，IIFE + window/globalThis 单例）
// 批次 2 · A1：把扁平的跨源搜索结果按「稳定聚合键（片名 + 季数 + 内容标签）」派生为分组视图。
// 只做纯内存 O(n) 派生，绝不修改传入数组，不触碰 lastSearchResults / 缓存 / 去重键。
//   - 分组键（titleGroupKey）与源内剧级键 ${source_code}_${vod_id} 是两层，互不混用；
//   - 归一化参考 LibreTV src/lib/cms-parser.ts:174（小写 + 去空白/标点/符号），
//     不用 js/danmu.js 的私有 normalizeTitle（语义是弹幕 bigram 近似匹配）；
//   - 只按「片名 + 季数（第 1 季等同无季）+ 内容标签」区分：年份不是所有片都有（空值很常见），
//     不作为区分条件；同名的上下部/特别篇/动态漫/语言版/解说预告保持独立，
//     完整版/合集/画质等版本标签视为同内容合并；真实集数不参与分桶（只取组内最大值展示），
//     同一部剧在不同源集数不一致（含 40 集与 265 集）仍是一张卡；
//   - 单条也成组（保持一卡一片）；组内按 source_name 排序；
//   - remarks 用 WDTVRemarks.inferGroupRemarks 汇总，模块缺失时静默降级；
//   - 另提供搜索关联度打分与关联度排序（scoreRelevance / rankGroupsByRelevance），
//     仅供展示层排序使用，不改分组键、不改缓存与去重键。
// =====================================
(function (g) {
    'use strict';

    // 归一化片名：小写、折叠空白、去标点/符号差异。幂等。
    // 用于跨标点差异匹配（源站存「摔跤吧!爸爸」而别处写「摔跤吧！爸爸」）。
    function normalizeTitle(s) {
        return String(s == null ? '' : s)
            .toLowerCase()
            .replace(/[\s\p{P}\p{S}]+/gu, '');
    }

    // 从播放地址列表读实际集数：MacCMS 用 # 分隔单集、$$$ 分隔播放组；
    // 取各播放组的最大单集数（多线路组通常集数一致，取最大可兼容线路残缺）。
    // 只统计「集名$http(s)地址」这种真正可播放的条目，与 api.js parsePlayGroup 的判定一致。
    function countFromPlayUrl(raw) {
        var s = raw == null ? '' : String(raw);
        if (!s) return 0;
        var groups = s.split('$$$');
        var max = 0;
        for (var i = 0; i < groups.length; i++) {
            var segs = String(groups[i] || '').split('#');
            var n = 0;
            for (var j = 0; j < segs.length; j++) {
                if (/\$https?:\/\/\S+/i.test(String(segs[j] || ''))) n++;
            }
            if (n > max) max = n;
        }
        return max;
    }

    // 真实集数：只统计该源播放列表里的实际可播放集数（MacCMS vod_play_url）。
    // 不从 vod_total 声明值或备注文案推断；没有播放列表时返回 undefined（集数未知）。
    // 搜索结果对象在会话内不变，用 WeakMap 记忆，避免渐进渲染每 250ms 重复解析长播放地址。
    var episodeMemo = (typeof WeakMap === 'function') ? new WeakMap() : null;
    function episodeCountOf(item) {
        if (!item || (typeof item !== 'object' && typeof item !== 'function')) return undefined;
        if (episodeMemo && episodeMemo.has(item)) return episodeMemo.get(item);
        var fromPlay = countFromPlayUrl(item.vod_play_url);
        var count = fromPlay > 0 ? fromPlay : undefined;
        if (episodeMemo) episodeMemo.set(item, count);
        return count;
    }

    function firstTruthy(items, field) {
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it && it[field]) return it[field];
        }
        return undefined;
    }

    function pickGroupName(items) {
        // 出现次数最多的原始片名；次数相同保留最先进入结果池的写法，
        // 避免某个源的小变体（如「庆余年（2019）」）成为整张卡的名称。
        var counts = Object.create(null);
        var order = [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var name = (it && it.vod_name != null) ? String(it.vod_name).trim() : '';
            if (!name) continue;
            if (counts[name] == null) {
                counts[name] = 0;
                order.push(name);
            }
            counts[name]++;
        }
        var best = '';
        var bestCount = 0;
        for (var j = 0; j < order.length; j++) {
            var candidate = order[j];
            if (counts[candidate] > bestCount) {
                best = candidate;
                bestCount = counts[candidate];
            }
        }
        return best;
    }

    function bySourceName(a, b) {
        var an = (a && a.source_name != null) ? String(a.source_name) : '';
        var bn = (b && b.source_name != null) ? String(b.source_name) : '';
        var cmp = an.localeCompare(bn);
        if (cmp) return cmp;
        var ac = (a && a.source_code != null) ? String(a.source_code) : '';
        var bc = (b && b.source_code != null) ? String(b.source_code) : '';
        return ac.localeCompare(bc);
    }

    function inferRemarks(items) {
        var R = g.WDTVRemarks;
        if (R && typeof R.inferGroupRemarks === 'function') {
            try {
                return R.inferGroupRemarks(items.map(function (it) { return it && it.vod_remarks; }));
            } catch (e) { /* 模块异常按 undefined 降级 */ }
        }
        return undefined;
    }

    function buildGroup(normKey, items, episodes) {
        // 不修改传入 items：先复制再排序
        var sorted = items.slice().sort(bySourceName);
        return {
            // 稳定 key：只由片名 + 季数 + 内容标签派生，不含集数、易变 URL 与组内顺序相关内容
            key: normKey,
            name: pickGroupName(items),
            episodes: episodes || undefined,
            items: sorted,
            remarks: inferRemarks(items),
            pic: firstTruthy(items, 'vod_pic'),
            typeName: firstTruthy(items, 'type_name')
        };
    }

    // 稳定聚合键：片名 + 季数（第 1 季等同无季）+ 影响内容差异的标签。
    //   - part：上部/上 → up，下部/下 → down（上下部是不同内容，保持独立）
    //   - 特别版/特别篇 → special（两种写法归为同一内容）
    //   - format：动态漫/动态漫画保持独立
    //   - language：粤语/国语等语言版保持独立
    //   - commentary/trailer：解说/预告等不同内容保持独立
    //   - 其余 version/quality 标签（完整版、合集、高清、4K…）忽略，视为同内容
    // 片名全空/全标点退化为 '__empty__'，不丢条目。
    function titleGroupKey(rawName) {
        var raw = String(rawName == null ? '' : rawName);
        var parsed = splitAttachedChineseSeason(parseTitleDecorations(raw));
        var base = parsed.base || normalizeTitle(raw);
        if (!base) return '__empty__';
        var tokens = [];
        // 标题里写明的上映年份仍算片名的一部分：无年份入口（庆余年）与
        // 标了年份的条目（庆余年 2019）是两种写法，不能被合并成同一张卡。
        if (parsed.year != null) tokens.push('y' + parsed.year);
        if (parsed.season > 1) tokens.push('s' + parsed.season);
        var tags = Array.isArray(parsed.tags) ? parsed.tags : [];
        for (var i = 0; i < tags.length; i++) {
            var tag = tags[i];
            if (!tag) continue;
            if (tag.type === 'part') {
                if (tag.label === '上部' || tag.label === '上') tokens.push('up');
                else if (tag.label === '下部' || tag.label === '下') tokens.push('down');
            } else if (tag.label === '特别版' || tag.label === '特别篇') {
                tokens.push('special');
            } else if (tag.type === 'format') {
                // 动态漫画/动态漫是同一内容的两种写法，归到同一个标签 token
                tokens.push(tag.label === '动态漫画' ? '动态漫' : tag.label);
            } else if (tag.type === 'language' || tag.type === 'commentary' || tag.type === 'trailer') {
                tokens.push(tag.label);
            }
        }
        var unique = [];
        tokens.forEach(function (token) {
            if (token && unique.indexOf(token) === -1) unique.push(token);
        });
        unique.sort();
        return unique.length > 0 ? base + '|' + unique.join('|') : base;
    }

    function aggregateResults(list) {
        if (!Array.isArray(list)) return [];
        var buckets = new Map();
        var order = [];
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            var rawName = (item && item.vod_name != null) ? String(item.vod_name) : '';
            var key = titleGroupKey(rawName);
            if (!buckets.has(key)) {
                buckets.set(key, []);
                order.push(key);
            }
            buckets.get(key).push(item);
        }
        var groups = [];
        order.forEach(function (key) {
            var items = buckets.get(key);
            // 展示用集数取组内真实集数最大值；全部未知则保持 undefined
            var episodes;
            items.forEach(function (it) {
                var c = episodeCountOf(it);
                if (c && (!episodes || c > episodes)) episodes = c;
            });
            groups.push(buildGroup(key, items, episodes));
        });
        return groups;
    }

    // ===== 搜索关联度打分 =====
    // 搜索接口（MacCMS wd=）多数按「更新时间」返回，而不是按相关性；
    // 有的源还会返回大量只沾边甚至不相关的条目（如按单字模糊命中）。
    // 因此列表展示必须在合并后按「片名 ↔ 关键词」重新排序，源优先级只用于同分兜底。
    //
    // 标题先拆成「基础片名 + 年份 + 季数 + 版本标签」再比较：
    //   庆余年                → base=庆余年
    //   庆余年 2019 / (2019)  → base=庆余年, year=2019
    //   庆余年第二季           → base=庆余年, season=2
    //   庆余年 第Ⅱ季 / 2 / 二 / 叁 / 拾贰 → base=庆余年, season=2/2/2/3/12
    //   庆余年第二季粤语        → base=庆余年, season=2, tags=[粤语]
    // 这样「同一部剧换了个写法」不会被长达好几字的长度惩罚压到衍生剧后面。
    // 权重顺序：完全一致 > 同年份 > 同季数 > 同剧不同季 > 同剧带语言/版本标签
    //          > 同剧预告/解说 > 同名前缀衍生剧 > 包含 > 模糊 > 无关。
    var CN_DIGIT = {
        '零': 0, '〇': 0,
        '一': 1, '壹': 1,
        '二': 2, '贰': 2, '貳': 2, '两': 2, '兩': 2,
        '三': 3, '叁': 3, '叄': 3,
        '四': 4, '肆': 4,
        '五': 5, '伍': 5,
        '六': 6, '陆': 6, '陸': 6,
        '七': 7, '柒': 7,
        '八': 8, '捌': 8,
        '九': 9, '玖': 9
    };
    var CN_UNIT = {
        '十': 10, '拾': 10,
        '百': 100, '佰': 100,
        '千': 1000, '仟': 1000,
        '万': 10000, '萬': 10000,
        '亿': 100000000, '億': 100000000
    };
    // 所有中文数字字符（小写 + 大写/金融 + 廿/卅 + 传统写法）
    var CN_NUM_CLASS = '零〇一壹二贰貳两兩三叁叄四肆五伍六陆陸七柒八捌九玖十拾百佰千仟万萬亿億廿卅';
    var CN_DIGIT_ONLY_RE = /^[零〇一壹二贰貳两兩三叁叄四肆五伍六陆陸七柒八捌九玖]+$/;
    var CN_NUM_SEQ_RE = new RegExp('^[' + CN_NUM_CLASS + ']+$');
    var CN_TRAILING_SEQ_RE = new RegExp('([' + CN_NUM_CLASS + ']+)$');
    // 中文数字年份只认逐位的 4 位写法（贰零贰肆 / 一九九四），不把「两」当首位
    var CN_YEAR_DIGITS = '零〇一壹二贰貳三叁叄四肆五伍六陆陸七柒八捌九玖';
    var CN_YEAR_RE = new RegExp('([' + CN_YEAR_DIGITS + ']{4})\\|*(?:年\\|*)?$');
    var SEASON_MARK_RE = new RegExp('第([0-9' + CN_NUM_CLASS + ']+)[季部]', 'g');
    var SEASON_EXT_RE = new RegExp('第\\|*([0-9]+|[ivxlcdm]+|[' + CN_NUM_CLASS + ']+)\\|*[季部]', 'g');
    var SEASON_EN_RE = /(?:^|\|)(?:season|series)\|*([0-9]+|[ivxlcdm]+)(?=\||$)/g;
    var SEASON_S_RE = /(^|[^a-z0-9])s\|*0*([0-9]{1,2})(?=\||$)/g;
    var SEASON_NUM_RE = /([0-9]{1,2})\|*[季部]/g;
    var SEASON_CN_RE = new RegExp('([' + CN_NUM_CLASS + ']+)\\|*[季部]', 'g');
    var SEASON_PART_RE = /(?:part|pt)\|*0*([0-9]{1,2})(?=\||$)/g;
    var SEASON_MID_NUM_RE = /(^|[^\d])([0-9]{1,2})(?=\|)/g;
    var SEASON_ZHI_NUM_RE = /(^|[^\d])([0-9]{1,2})(?=之)/g;
    var SEASON_END_NUM_RE = /(^|[^\d])([0-9]{1,2})(?=\||$)/g;
    var SEASON_END_ROMAN_RE = /(^|[^a-z0-9])([ivx]{1,4})(?=\||$)/g;
    var SEASON_END_CN_RE = new RegExp('(^|\\|)([' + CN_NUM_CLASS + '])(?=\\|$)', 'g');
    // 字形变体归一：大写/金融数字与常见繁体在片名里与简体写法等价。
    // 只映射到「同义简体数字/汉字」，不把 伍/陆/柒/玖 强转成 五/六/七/九，
    // 避免把「伍佰」「陆小凤」「柒」「玖」这类人名/片名改成另一个词；
    // 这些字符作为季数出现时由 parseNumericToken 按数字处理。
    var CN_VARIANT_MAP = {
        '壹': '一', '贰': '二', '貳': '二', '叁': '三', '叄': '三',
        '肆': '四', '捌': '八', '拾': '十', '佰': '百', '仟': '千',
        '萬': '万', '億': '亿', '兩': '两', '陸': '陆', '〇': '零'
    };
    var CN_VARIANT_RE = /[壹贰貳叁叄肆捌拾佰仟萬億兩陸〇]/g;

    function normalizeCnVariants(text) {
        return String(text == null ? '' : text).replace(CN_VARIANT_RE, function (ch) {
            return CN_VARIANT_MAP[ch] || ch;
        });
    }
    var ROMAN_TABLE = ['', 'i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x',
        'xi', 'xii', 'xiii', 'xiv', 'xv', 'xvi', 'xvii', 'xviii', 'xix', 'xx'];

    function cnNumberToArabic(raw) {
        var s = String(raw == null ? '' : raw);
        if (/^\d+$/.test(s)) return String(parseInt(s, 10));
        if (!CN_NUM_SEQ_RE.test(s)) return s;
        // 廿 / 卅 先展开成二十 / 三十
        s = s.replace(/廿/g, '二十').replace(/卅/g, '三十');
        // 纯数字逐位写法（年份/编号常见）：贰零贰肆 → 2024，叁 → 3
        if (CN_DIGIT_ONLY_RE.test(s) && s.length > 1) {
            var digits = '';
            for (var i = 0; i < s.length; i++) digits += String(CN_DIGIT[s.charAt(i)]);
            return digits;
        }
        var total = 0;
        var section = 0;
        var number = 0;
        for (var j = 0; j < s.length; j++) {
            var ch = s.charAt(j);
            if (CN_DIGIT[ch] !== undefined) {
                number = CN_DIGIT[ch];
                continue;
            }
            var unit = CN_UNIT[ch];
            if (unit === undefined) continue;
            if (unit >= 10000) {
                total += (section + number) * unit;
                section = 0;
                number = 0;
            } else {
                if (number === 0 && unit === 10) number = 1; // 十 = 一十
                section += number * unit;
                number = 0;
            }
        }
        total += section + number;
        return total > 0 ? String(total) : s;
    }

    // 只认 1~20 的标准罗马数字（I/II/III/IV…XX），避免把 civil、liv 之类单词误判成季数。
    function romanToNumber(raw) {
        return ROMAN_TABLE.indexOf(String(raw == null ? '' : raw).toLowerCase());
    }

    function parseNumericToken(token) {
        var s = String(token == null ? '' : token);
        if (/^\d+$/.test(s)) {
            var n = parseInt(s, 10);
            return (n >= 1 && n <= 99) ? n : null;
        }
        if (/^[ivx]+$/.test(s)) {
            var r = romanToNumber(s);
            return r > 0 ? r : null;
        }
        if (CN_NUM_SEQ_RE.test(s)) {
            var c = parseInt(cnNumberToArabic(s), 10);
            return (c >= 1 && c <= 99) ? c : null;
        }
        return null;
    }

    // 去掉标点/空白后的紧凑串（不折季数），用于基础片名比较。
    function foldCompact(s) {
        var text = String(s == null ? '' : s);
        try {
            if (typeof text.normalize === 'function') text = text.normalize('NFKC');
        } catch (e) { /* 极端环境下保持原串 */ }
        return normalizeCnVariants(normalizeTitle(text));
    }

    // 完整片名的兜底归一（保留旧版「第X季 → X」行为），只在结构化比较失败时使用。
    function foldForMatch(s) {
        var text = foldCompact(s);
        text = text.replace(SEASON_MARK_RE, function (_, num) {
            return cnNumberToArabic(num);
        });
        text = text.replace(/(?:season|series)(\d+)/g, '$1');
        return text;
    }

    // 内嵌罗马数字归一：两个汉字之间的 ii/iii/iv/vi/vii/viii/ix 转成阿拉伯数字，
    // 让「斗罗大陆Ⅱ绝世唐门」与「斗罗大陆2绝世唐门」解析出同一个基础片名。
    // 长词优先（viii → vii → iii → iv/ix/vi/ii），并保留原有「第Ⅱ季」等尾部识别。
    var INLINE_ROMAN_RE = /([\u4e00-\u9fff])(viii|vii|iii|iv|ix|vi|ii)(?=[\u4e00-\u9fff])/g;
    function normalizeInlineRoman(text) {
        return String(text == null ? '' : text).replace(INLINE_ROMAN_RE, function (m, pre, token) {
            var n = romanToNumber(token);
            return n > 0 ? pre + String(n) : m;
        });
    }

    // 解析用文本：NFKC + 小写，标点/空白统一变成 | 分隔符（保留「(2019)」这类边界信息）。
    function toParseText(s) {
        var text = String(s == null ? '' : s);
        try {
            if (typeof text.normalize === 'function') text = text.normalize('NFKC');
        } catch (e) { /* 保留原串 */ }
        text = normalizeInlineRoman(text.toLowerCase());
        text = normalizeCnVariants(text.replace(/[\s\p{P}\p{S}]+/gu, '|'));
        return trimSeparators(text);
    }

    function trimSeparators(text) {
        return String(text == null ? '' : text)
            .replace(/^\|+/, '').replace(/\|+$/, '').replace(/\|{2,}/g, '|');
    }

    // 季/部标记：「第2季」「第二季」「第Ⅱ季」「Season 2」「S02」「Part 2」「2季」，
    // 以及结尾的单个数字/中文数字/罗马数字（阿凡达2、庆余年二、Rocky IV）。
    function extractSeason(text) {
        var season = null;
        function take(n) {
            if (season == null && typeof n === 'number' && n >= 1) season = n;
            return '|';
        }
        text = text.replace(SEASON_EXT_RE, function (m, token) {
            var n = parseNumericToken(token);
            return n == null ? m : take(n);
        });
        text = text.replace(SEASON_EN_RE, function (m, token) {
            var n = parseNumericToken(token);
            return n == null ? m : take(n);
        });
        text = text.replace(SEASON_S_RE, function (m, pre, num) {
            var n = parseInt(num, 10);
            if (!(n >= 1)) return m;
            take(n);
            return pre;
        });
        text = text.replace(SEASON_NUM_RE, function (m, num) {
            var n = parseInt(num, 10);
            return n >= 1 ? take(n) : m;
        });
        // 二季 / 三部 / 叁季 / 拾贰季（不带「第」的中文数字写法）
        text = text.replace(SEASON_CN_RE, function (m, token) {
            var n = parseNumericToken(token);
            return n == null ? m : take(n);
        });
        text = text.replace(SEASON_PART_RE, function (m, num) {
            var n = parseInt(num, 10);
            if (!(n >= 1)) return m;
            take(n);
            return '|';
        });
        // 片名 + 数字 + 副标题：碟中谍8：最终清算 / 流浪地球2：再次冒险
        // 数字必须紧跟分隔符，2019 这类四位年份不会被拆（19/9 前一位仍是数字）。
        text = text.replace(SEASON_MID_NUM_RE, function (m, pre, num) {
            var n = parseInt(num, 10);
            if (!(n >= 1)) return m;
            take(n);
            return pre;
        });
        // 中文续作常见「数字 + 之」写法：庆余年2之少年风流
        text = text.replace(SEASON_ZHI_NUM_RE, function (m, pre, num) {
            var n = parseInt(num, 10);
            if (!(n >= 1)) return m;
            take(n);
            return pre;
        });
        // 结尾 1~2 位阿拉伯数字：阿凡达2 / 唐探 3 / 碟中谍7
        text = text.replace(SEASON_END_NUM_RE, function (m, pre, num) {
            var n = parseInt(num, 10);
            if (!(n >= 1)) return m;
            take(n);
            return pre;
        });
        // 结尾罗马数字：Rocky IV / 庆余年Ⅱ（NFKC 已把 Ⅱ 变成 II）
        text = text.replace(SEASON_END_ROMAN_RE, function (m, pre, token) {
            var n = romanToNumber(token);
            if (!(n >= 1)) return m;
            take(n);
            return pre;
        });
        // 结尾独立成词的中文数字：庆余年 二 / 庆余年 叁。
        // 直接贴在片名后的（庆余年二、庆余年叁）留给 splitAttachedChineseSeason
        // 在比较时处理，避免「独一无二」「接二连三」被误拆。
        text = text.replace(SEASON_END_CN_RE, function (m, pre, token) {
            var n = CN_DIGIT[token];
            if (!(n >= 1)) return m;
            take(n);
            return pre;
        });
        return { text: trimSeparators(text), season: season };
    }

    // 只抽取「追加在片名末尾」的年份（含 2019年 / (2019)），
    // 不抽片头年份，避免把「2001太空漫游」「1917：逆战」这类片名里的数字当成上映年份。
    function extractTrailingYear(text) {
        var year = null;
        var m = text.match(/((?:19|20)\d{2})\|*(?:年\|*)?$/);
        if (m) {
            var before = m.index > 0 ? text.charAt(m.index - 1) : '';
            if (!/\d/.test(before)) {
                year = parseInt(m[1], 10);
                text = text.slice(0, m.index);
            }
        }
        // 中文数字年份：贰零贰肆 / 二零二四年（只认逐位四位写法）
        if (year == null) {
            var cm = text.match(CN_YEAR_RE);
            if (cm) {
                var beforeCn = cm.index > 0 ? text.charAt(cm.index - 1) : '';
                if (!beforeCn || (!/\d/.test(beforeCn) && !CN_NUM_SEQ_RE.test(beforeCn))) {
                    var yearDigits = '';
                    for (var i = 0; i < cm[1].length; i++) yearDigits += String(CN_DIGIT[cm[1].charAt(i)]);
                    var cnYear = parseInt(yearDigits, 10);
                    if (cnYear >= 1900 && cnYear <= 2099) {
                        year = cnYear;
                        text = text.slice(0, cm.index);
                    }
                }
            }
        }
        return { text: trimSeparators(text), year: year };
    }

    // 常见后缀标签：语言/版本/画质/预告/解说。
    // 只从片名末尾剥离，避免误伤片名开头的词（例如「粤语残片」）。
    var DECORATION_TAGS = [
        { label: '电影解说', type: 'commentary', factor: 0.86 },
        { label: '影视解说', type: 'commentary', factor: 0.86 },
        { label: '解说', type: 'commentary', factor: 0.88 },
        { label: '速看', type: 'commentary', factor: 0.88 },
        { label: '混剪', type: 'commentary', factor: 0.88 },
        { label: '预告片', type: 'trailer', factor: 0.82 },
        { label: '预告', type: 'trailer', factor: 0.84 },
        { label: '花絮', type: 'trailer', factor: 0.85 },
        { label: '片段', type: 'trailer', factor: 0.85 },
        { label: '抢先版', type: 'version', factor: 0.86 },
        { label: '枪版', type: 'version', factor: 0.84 },
        { label: 'ts版', type: 'version', factor: 0.85 },
        { label: 'tc版', type: 'version', factor: 0.85 },
        { label: '特别版', type: 'version', factor: 0.96 },
        { label: '特别篇', type: 'version', factor: 0.96 },
        { label: '动态漫画', type: 'format', factor: 0.98 },
        { label: '动态漫', type: 'format', factor: 0.98 },
        { label: '合集篇', type: 'version', factor: 0.97 },
        { label: '上部', type: 'part', factor: 0.98 },
        { label: '下部', type: 'part', factor: 0.98 },
        // 单字「上/下」只剥离独立成词的分部标记（流浪地球3（上）），
        // 不能剥「云上」这类正常片名。
        { label: '上', type: 'part', factor: 0.98, standaloneOnly: true },
        { label: '下', type: 'part', factor: 0.98, standaloneOnly: true },
        { label: '未删减版', type: 'version', factor: 0.96 },
        { label: '未删减', type: 'version', factor: 0.96 },
        { label: '完整版', type: 'version', factor: 0.97 },
        { label: '加长版', type: 'version', factor: 0.97 },
        { label: '全集', type: 'version', factor: 0.98 },
        { label: '合集', type: 'version', factor: 0.97 },
        { label: '导演剪辑版', type: 'version', factor: 0.96 },
        { label: '重制版', type: 'version', factor: 0.97 },
        { label: '修复版', type: 'version', factor: 0.97 },
        { label: '高清版', type: 'version', factor: 0.97 },
        { label: '蓝光版', type: 'version', factor: 0.97 },
        { label: '粤语版', type: 'language', factor: 0.97 },
        { label: '国语版', type: 'language', factor: 0.97 },
        { label: '粤语', type: 'language', factor: 0.97 },
        { label: '国语', type: 'language', factor: 0.97 },
        { label: '普通话', type: 'language', factor: 0.97 },
        { label: '中文字幕', type: 'language', factor: 0.98 },
        { label: '中字', type: 'language', factor: 0.98 },
        { label: '双语', type: 'language', factor: 0.98 },
        { label: '英语', type: 'language', factor: 0.97 },
        { label: '日语', type: 'language', factor: 0.97 },
        { label: '韩语', type: 'language', factor: 0.97 },
        { label: '60帧', type: 'quality', factor: 0.98 },
        { label: '2160p', type: 'quality', factor: 0.98 },
        { label: '1080p', type: 'quality', factor: 0.98 },
        { label: '720p', type: 'quality', factor: 0.98 },
        { label: '4k', type: 'quality', factor: 0.98 },
        { label: 'hd', type: 'quality', factor: 0.98 },
        { label: '高清', type: 'quality', factor: 0.98 },
        { label: '蓝光', type: 'quality', factor: 0.98 }
    ].sort(function (a, b) { return b.label.length - a.label.length; });

    // 从末尾反复剥离标签（如「庆余年第二季粤语」→ 粤语；「…[电影解说]」→ 电影解说）。
    // 至少保留一个非空片名，避免把纯标签标题（如片名就叫「高清」）剥空。
    function stripTrailingTags(text, tagsOut) {
        var changed = true;
        var guard = 0;
        while (changed && guard++ < 12) {
            changed = false;
            text = trimSeparators(text);
            for (var i = 0; i < DECORATION_TAGS.length; i++) {
                var spec = DECORATION_TAGS[i];
                var label = spec.label;
                if (!label || text.length < label.length) continue;
                if (text.slice(-label.length) !== label) continue;
                var idx = text.length - label.length;
                var before = idx > 0 ? text.charAt(idx - 1) : '';
                var standalone = idx === 0 || before === '|';
                // 直接贴在片名/季数/年份后的标签（庆余年粤语、庆余年2粤语）：
                // 只拦英文字母（避免 avhd 这类单词误剥），数字后的标签照常剥离。
                var attached = idx > 0 && before !== '|' && !/[a-z]/.test(before);
                if (!standalone && !attached) continue;
                if (spec.standaloneOnly && !standalone) continue;
                var next = trimSeparators(text.slice(0, idx));
                if (!next) continue;
                if (!tagsOut.some(function (t) { return t.label === label; })) tagsOut.push(spec);
                text = next;
                changed = true;
                break;
            }
        }
        return trimSeparators(text);
    }

    // 标题解析结果带缓存：同一批搜索结果会在渐进渲染中反复打分。
    var parseCache = new Map();
    var PARSE_CACHE_MAX = 4000;

    function parseTitleDecorations(raw) {
        var key = String(raw == null ? '' : raw);
        var cached = parseCache.get(key);
        if (cached) return cached;

        var compact = foldCompact(key);
        var text = toParseText(key);
        var season = null;
        var year = null;
        var tags = [];
        var base = compact;

        if (text) {
            var seasonOut = extractSeason(text);
            text = seasonOut.text;
            season = seasonOut.season;

            var yearOut = extractTrailingYear(text);
            text = yearOut.text;
            year = yearOut.year;

            text = stripTrailingTags(text, tags);

            var yearAgain = extractTrailingYear(text);
            text = yearAgain.text;
            if (year == null) year = yearAgain.year;

            // 剥离语言/版本标签后可能才露出「片名 + 数字」写法（庆余年2粤语 → 庆余年2），
            // 这里再跑一次季数识别，让「2 粤语」也能被当成第二季的语言版。
            var seasonAgain = extractSeason(text);
            text = seasonAgain.text;
            if (season == null) season = seasonAgain.season;

            base = text.replace(/\|/g, '');
        }

        // 片名只由年份/季数/标签组成（如「2019」「第二季」「高清」）：
        // 退回完整片名，不拆元数据，避免把这些片名当成任意作品的标记。
        if (!base) {
            base = compact;
            season = null;
            year = null;
            tags = [];
        }

        var out = {
            base: base,
            year: year,
            season: season,
            tags: tags,
            compact: compact,
            plain: foldForMatch(key)
        };
        if (parseCache.size >= PARSE_CACHE_MAX) {
            parseCache.delete(parseCache.keys().next().value);
        }
        parseCache.set(key, out);
        return out;
    }

    // 紧凑片名末尾直接贴着中文数字（庆余年二、爱情公寓十一）：
    // 比较时规范成「基础片名 + 季数」，但保留至少两位片名，避免把「十二」这类片名拆空。
    // 多字数字序列（一九四二）无法解析成 1~99 的数值时保持原样。
    function splitAttachedChineseSeason(parsed) {
        if (!parsed || parsed.season != null || !parsed.base) return parsed;
        var m = parsed.base.match(CN_TRAILING_SEQ_RE);
        if (!m) return parsed;
        var core = parsed.base.slice(0, parsed.base.length - m[1].length);
        if (core.length < 2) return parsed;
        var n = parseInt(cnNumberToArabic(m[1]), 10);
        if (!(n >= 1 && n <= 99)) return parsed;
        return {
            base: core,
            year: parsed.year,
            season: n,
            tags: parsed.tags,
            plain: parsed.plain
        };
    }

    // 查询词后面紧跟 1~2 位数字再接中文副标题（碟中谍8最终清算、三体2黑暗森林）：
    // 在“已知查询词”的上下文里推断季数，补上无分隔符写法；数字后必须是中文，
    // 因此 3D、4K、2019、7号房 这类数字不会被误判。
    function inferSeasonAfterQuery(qBase, parsed) {
        if (!parsed || parsed.season != null || !parsed.base || !qBase || qBase.length < 2) return parsed;
        if (parsed.base.indexOf(qBase) !== 0) return parsed;
        var rest = parsed.base.slice(qBase.length);
        var m = rest.match(/^(\d{1,2})([\u4e00-\u9fff].*)$/);
        if (!m) return parsed;
        var n = parseInt(m[1], 10);
        if (!(n >= 1 && n <= 99)) return parsed;
        return {
            base: qBase + m[2],
            year: parsed.year,
            season: n,
            tags: parsed.tags,
            compact: parsed.compact,
            plain: parsed.plain
        };
    }

    function charBigrams(s) {
        if (!s) return [];
        if (s.length < 2) return [s];
        var out = [];
        for (var i = 0; i < s.length - 1; i++) out.push(s.charAt(i) + s.charAt(i + 1));
        return out;
    }

    // 二元组 Dice 系数（0..1）：衡量两个标题的字面重合度，顺序不同会显著降分。
    function bigramDice(a, b) {
        var x = charBigrams(a);
        var y = charBigrams(b);
        if (!x.length || !y.length) return 0;
        var counts = Object.create(null);
        var i;
        for (i = 0; i < x.length; i++) counts[x[i]] = (counts[x[i]] || 0) + 1;
        var inter = 0;
        for (i = 0; i < y.length; i++) {
            if (counts[y[i]]) { inter++; counts[y[i]]--; }
        }
        return (2 * inter) / (x.length + y.length);
    }

    // 关键词字符在标题中的覆盖率（去重后）：给「唐探1900 ↔ 唐人街探案1900」这类缩写兜底。
    function charCoverage(needle, haystack) {
        if (!needle) return 0;
        var seen = Object.create(null);
        var distinct = 0;
        var i;
        for (i = 0; i < needle.length; i++) {
            var c = needle.charAt(i);
            if (!seen[c]) { seen[c] = 1; distinct++; }
        }
        if (!distinct) return 0;
        var hit = 0;
        for (var key in seen) {
            if (haystack.indexOf(key) !== -1) hit++;
        }
        return hit / distinct;
    }

    function isSubsequence(needle, haystack) {
        var j = 0;
        for (var i = 0; i < haystack.length && j < needle.length; i++) {
            if (haystack.charAt(i) === needle.charAt(j)) j++;
        }
        return j === needle.length;
    }

    // 基础片名之间的分层打分（不含年份/季数/标签）：
    //   10000        完全一致
    //   6100~8000    标题以关键词开头
    //   5100~6000    标题中间包含关键词
    //   4100~5500    标题是关键词的前缀
    //   3100~5000    标题是关键词的一部分
    //   0~2900       模糊匹配；无有效重合返回 0
    function scoreBase(q, t) {
        if (!q || !t) return 0;
        if (q === t) return 10000;

        var qLen = q.length;
        var tLen = t.length;
        var at = t.indexOf(q);
        if (at === 0) {
            return Math.max(6100, 8000 - Math.max(0, tLen - qLen) * 120);
        }
        if (at > 0) {
            return Math.max(5100, 6000 - Math.max(0, tLen - qLen) * 100 - at * 50);
        }
        // 标题很短时（单字）不作为「关键词的一部分」，避免一个常用字把无关条目抬到前排。
        if (tLen >= 2) {
            var qAt = q.indexOf(t);
            if (qAt === 0) {
                return Math.max(4100, 5500 - Math.max(0, qLen - tLen) * 100);
            }
            if (qAt > 0) {
                return Math.max(3100, 5000 - Math.max(0, qLen - tLen) * 100 - qAt * 50);
            }
        }

        var dice = bigramDice(q, t);
        var cover = charCoverage(q, t);
        if (dice < 0.18 && cover < 0.6) return 0;
        var fuzzy = 1200 * dice + 600 * cover;
        if (isSubsequence(q, t)) fuzzy += 300;
        return Math.min(2900, Math.round(fuzzy));
    }

    function tagLabelSet(tags) {
        var out = Object.create(null);
        for (var i = 0; i < tags.length; i++) out[tags[i].label] = true;
        return out;
    }

    // 元数据权重：基础片名一致时，按年份/季数/标签的匹配程度做小幅折减。
    // 折减幅度刻意控制在 0.82~1.0，保证它只调整「同一部剧内部」的顺序，
    // 不会让带标记的同剧条目跌到衍生剧/无关结果后面。
    function metadataFactor(query, title) {
        var f = 1;
        if (title.season != null) {
            if (query.season != null) {
                if (query.season !== title.season) {
                    f *= Math.max(0.84, 0.93 - Math.abs(query.season - title.season) * 0.03);
                }
            } else {
                // 无季数关键词：第 1 季最接近，后续季数依次轻微递减
                f *= Math.max(0.90, 0.965 - (title.season - 1) * 0.005);
            }
        } else if (query.season != null) {
            // 搜具体季数时，未标季数的总入口仍然相关，但低于同季
            f *= 0.94;
        }

        if (title.year != null) {
            if (query.year != null) {
                if (query.year !== title.year) f *= 0.90;
            } else {
                // 年份只是源的标注差异，几乎不降权
                f *= 0.985;
            }
        } else if (query.year != null) {
            f *= 0.96;
        }

        var queryTags = tagLabelSet(query.tags);
        var titleTags = tagLabelSet(title.tags);
        for (var i = 0; i < title.tags.length; i++) {
            if (!queryTags[title.tags[i].label]) f *= title.tags[i].factor;
        }
        for (var j = 0; j < query.tags.length; j++) {
            if (!titleTags[query.tags[j].label]) f *= 0.95;
        }
        return f;
    }

    // 关联度分数（越大越相关）：
    //   - 先按基础片名算分层分；
    //   - 再用年份/季数/标签做小幅折减；
    //   - 同时保留完整片名的兜底分（结构化解析失败时不至于丢分）。
    function scoreRelevance(query, title) {
        var q = splitAttachedChineseSeason(parseTitleDecorations(query));
        var t = splitAttachedChineseSeason(parseTitleDecorations(title));
        // 归一化后完全一致（只差标点/空白/全角）：直接满分，避免元数据推断让精确匹配掉分。
        if (q.compact && q.compact === t.compact) return 10000;
        t = inferSeasonAfterQuery(q.base, t);
        var structured = 0;
        if (q.base && t.base) {
            var baseScore = scoreBase(q.base, t.base);
            // 同剧续作带副标题（碟中谍8：最终清算）：识别出季数后，副标题长度不应
            // 按普通衍生剧的 120/字 惩罚，否则会被「电影解说」等版本挤到后面。
            if (t.season != null && q.base.length >= 2 && t.base.indexOf(q.base) === 0) {
                var extra = t.base.length - q.base.length;
                if (extra > 0 && extra <= 24) {
                    baseScore = Math.max(baseScore, Math.max(8800, 9700 - extra * 60));
                }
            }
            structured = baseScore * metadataFactor(q, t);
        }
        var plain = scoreBase(q.plain, t.plain);
        return Math.round(Math.max(structured, plain));
    }

    // 关联度优先的分组排序：score 降序 → 进入结果池的先后。
    // 源优先级不参与列表排序：它只用于组内选源（卡片主条目/换源顺序），
    // 因此不会再把「前三源」的卡片强行提到前排。
    // 同视频聚合本身在 aggregateResults / 渐进渲染去重中完成，与排序无关。
    function rankGroupsByRelevance(groups, query) {
        var list = Array.isArray(groups) ? groups : [];
        return list.map(function (g, idx) {
            return {
                g: g,
                idx: idx,
                score: scoreRelevance(query, g && g.name)
            };
        }).sort(function (a, b) {
            return (b.score - a.score) || (a.idx - b.idx);
        }).map(function (x) { return x.g; });
    }

    g.WDTVGroup = {
        aggregateResults: aggregateResults,
        titleGroupKey: titleGroupKey,
        normalizeTitle: normalizeTitle,
        episodeCountOf: episodeCountOf,
        foldForMatch: foldForMatch,
        parseTitleDecorations: parseTitleDecorations,
        scoreRelevance: scoreRelevance,
        rankGroupsByRelevance: rankGroupsByRelevance
    };
})(typeof window !== 'undefined' ? window : globalThis);
