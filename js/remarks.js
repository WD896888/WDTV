// =====================================
// WDTV 播放备注归一（零依赖纯函数，IIFE + window/globalThis 单例）
// 参考 LibreTV src/lib/remarks.ts：各采集源对同一部剧的「全34集 / 完结 / 更新至34集」
// 各写各的，归一后统一显示；只处理「集数」与「完结状态」，其余（HD国语 / 正片）原样。
// 批次 2：供 js/aggregate.js（inferGroupRemarks）与 js/app.js（卡片 badge）复用。
// =====================================
(function (g) {
    'use strict';

    var EPISODE_COUNT = /(\d+)\s*集/;
    // 「剧终」而不单是「终」——否则「终极版」会被误判成已完结
    var FINISHED_WORD = /完结|大结局|全集|剧终/;
    var FINISHED_PREFIX = /(?:全|共)\s*\d+\s*集/;
    var FINISHED_SUFFIX = /\d+\s*集\s*全/;

    function isFinished(text) {
        return FINISHED_WORD.test(text) || FINISHED_PREFIX.test(text) || FINISHED_SUFFIX.test(text);
    }

    function episodeCount(text) {
        var m = EPISODE_COUNT.exec(text);
        return m ? Number(m[1]) : 0;
    }

    // 归一备注：输出仅 全N集 / 更新至N集 / 已完结 / 原样四种，幂等。
    // 已归一的文案再跑一次结果不变，因此聚合阶段与渲染阶段都调它也不会变样。
    function formatRemarks(raw) {
        var text = (raw == null ? '' : String(raw)).trim();
        if (!text) return undefined;
        var finished = isFinished(text);
        var count = episodeCount(text);
        if (count > 0) return finished ? ('全' + count + '集') : ('更新至' + count + '集');
        // 没有集数时，只有「完结」类表述能归一，别的保持原样
        if (finished) return '已完结';
        return text;
    }

    // 选源列表里的紧凑备注：「更新至1277集」在「源名 / 画质 / 集数」那一行里
    // 前缀没有信息量，压成「1277 集」；单集影片不显示集数（没有「更到几集」这回事）。
    function compactRemarks(raw) {
        var text = formatRemarks(raw);
        if (!text) return undefined;
        var episode = /^(?:全|更新至)(\d+)集$/.exec(text);
        if (episode) {
            var count = parseInt(episode[1], 10);
            return count > 1 ? (count + ' 集') : undefined;
        }
        var prefixed = /^(?:全|更(?:新至|新|至))\s*(.+)$/.exec(text);
        if (prefixed) return prefixed[1].trim() || undefined;
        return text;
    }

    // 推断整组（同一部剧所有来源）的统一备注。
    // 优先级：总集数 > 完结 > 进度。拿「更新至N集」当总集数是错的（那是进度）。
    // 多个总集数取最大；全部为空返回 undefined。
    function inferGroupRemarks(raws) {
        var total = 0, progress = 0, finished = false, fallback;
        var arr = Array.isArray(raws) ? raws : [];
        for (var i = 0; i < arr.length; i++) {
            var text = formatRemarks(arr[i]);
            if (!text) continue;
            if (fallback === undefined) fallback = text;
            var tm = /^全(\d+)集$/.exec(text);
            if (tm) { total = Math.max(total, Number(tm[1])); continue; }
            var pm = /^更新至(\d+)集$/.exec(text);
            if (pm) { progress = Math.max(progress, Number(pm[1])); continue; }
            if (text === '已完结') finished = true;
        }
        if (total > 0) return '全' + total + '集';
        if (finished) return '已完结';
        if (progress > 0) return '更新至' + progress + '集';
        return fallback;
    }

    g.WDTVRemarks = {
        formatRemarks: formatRemarks,
        compactRemarks: compactRemarks,
        inferGroupRemarks: inferGroupRemarks
    };
})(typeof window !== 'undefined' ? window : globalThis);
