// =====================================
// WDTV 跨源同名聚合（零依赖纯函数，IIFE + window/globalThis 单例）
// 批次 2 · A1：把扁平的跨源搜索结果按「归一化片名 + 年份」派生为分组视图。
// 只做纯内存 O(n) 派生，绝不修改传入数组，不触碰 lastSearchResults / 缓存 / 去重键。
//   - 分组键（归一化片名）与源内剧级键 ${source_code}_${vod_id} 是两层，互不混用；
//   - 归一化参考 LibreTV src/lib/cms-parser.ts:174（小写 + 去空白/标点/符号），
//     不用 js/danmu.js 的私有 normalizeTitle（语义是弹幕 bigram 近似匹配）；
//   - 年份不一致时按年份拆桶（同名翻拍）；仅一个年份时无年份条目并入该桶；
//     多个年份且存在无年份条目时无年份条目单独成组（参考 video-card.tsx:45-66）；
//   - 单条也成组（保持一卡一片）；组内按 source_name 排序；
//   - remarks 用 WDTVRemarks.inferGroupRemarks 汇总，模块缺失时静默降级。
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

    // 年份只从明确的年份字段读取（MacCMS 常带 vod_year），不从片名数字猜，
    // 避免《2012》这类片名里自带的数字被误判成年份。
    function readYear(item) {
        if (!item) return '';
        var raw = item.vod_year != null ? String(item.vod_year)
                : (item.year != null ? String(item.year) : '');
        var m = raw.match(/(?:19|20)\d{2}/);
        return m ? m[0] : '';
    }

    function firstTruthy(items, field) {
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it && it[field]) return it[field];
        }
        return undefined;
    }

    function pickName(items) {
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it && it.vod_name != null) {
                var name = String(it.vod_name).trim();
                if (name) return name;
            }
        }
        return '';
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

    function buildGroup(normKey, year, items) {
        // 不修改传入 items：先复制再排序
        var sorted = items.slice().sort(bySourceName);
        return {
            // 稳定 key：仅由归一化片名 + 年份派生，不含易变 URL、不含组内顺序相关内容
            key: normKey + '|' + (year || ''),
            name: pickName(items),
            year: year || undefined,
            items: sorted,
            remarks: inferRemarks(items),
            pic: firstTruthy(items, 'vod_pic'),
            typeName: firstTruthy(items, 'type_name')
        };
    }

    function aggregateResults(list) {
        if (!Array.isArray(list)) return [];
        var byName = new Map();
        for (var i = 0; i < list.length; i++) {
            var item = list[i];
            var rawName = (item && item.vod_name != null) ? String(item.vod_name) : '';
            var norm = normalizeTitle(rawName);
            // 空片名 / 全标点片名仍要成组、不丢：退化用原始 trim 作桶键
            var bucketKey = norm || rawName.trim() || '__empty__';
            if (!byName.has(bucketKey)) byName.set(bucketKey, []);
            byName.get(bucketKey).push(item);
        }
        var groups = [];
        byName.forEach(function (items, normKey) {
            var yearsSet = new Set();
            for (var j = 0; j < items.length; j++) {
                var y = readYear(items[j]);
                if (y) yearsSet.add(y);
            }
            var years = Array.from(yearsSet);
            if (years.length > 1) {
                // 同名翻拍：按年份拆桶
                years.forEach(function (y) {
                    var bucket = items.filter(function (it) { return readYear(it) === y; });
                    groups.push(buildGroup(normKey, y, bucket));
                });
                // 无年份条目单独成组（参考 video-card.tsx）
                var noYear = items.filter(function (it) { return !readYear(it); });
                if (noYear.length) groups.push(buildGroup(normKey, undefined, noYear));
            } else {
                // 仅一个年份（或无年份）：无年份条目并入该桶
                groups.push(buildGroup(normKey, years[0], items));
            }
        });
        return groups;
    }

    g.WDTVGroup = {
        aggregateResults: aggregateResults,
        normalizeTitle: normalizeTitle
    };
})(typeof window !== 'undefined' ? window : globalThis);
