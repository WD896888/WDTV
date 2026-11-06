// =====================================
// WDTV 画质探测队列（闭包工厂，零依赖 / 零网络 / 零 DOM / 零存储）
// =====================================
// 为什么需要它：搜索页单源卡片进入视口即探测，一屏十几张，各发一次请求会瞬间把
// 源站与服务端的 per-host 闸门打满。本模块把散点探测收敛成受控的批量请求。
//
// 策略：
// - 同 key（源 + 影片）只跑一次，重复入队共享同一个结果 Promise；
// - mergeWindowMs 合并窗口：同一轮渲染周期入队的条目合成一个请求；
// - 最多 concurrency 个请求在飞、每批最多 batchSize 条；
// - onStart 只在批次「真正交给 run」时回调一次（排队期间不谎称「探测中」）；
// - 单批 run 抛错只让该批按失败收尾，队列继续；
// - run 提前结束（未回调结果）按「已取消」收尾，调用方不会永远挂起；
// - 看门狗按 timeoutMs 把无结果条目以「探测超时」收尾并释放槽位
//   （队列是全局单例，2 个槽被挂起等于全站停摆）；
// - cancel 对尚未发出的键立即返回取消结论且不发请求。
//
// 本模块本身不发起任何 fetch、不碰 DOM、不碰存储、不 import 其它模块
// （内部自带一份 key 生成，避免加载顺序依赖）。探测执行由 deps.run 注入。
//
// 浏览器挂 window.WDTVProbeQueue，Node 经 globalThis 供零依赖自测引用。
(function (g) {
  'use strict';

  // 内部 key 默认与 WDTV 搜索项复合键一致：`${source_code}_${vod_id}`。
  // 与 quality.js 的 qualityKey（':' 分隔）各自服务不同的 Map，互不耦合。
  function joinKey(sourceKey, vodId) {
    return String(sourceKey == null ? '' : sourceKey) + '_' + String(vodId == null ? '' : vodId);
  }
  function itemParts(item) {
    var i = item || {};
    var sc = i.sourceKey != null ? i.sourceKey
      : (i.sourceCode != null ? i.sourceCode
        : (i.source_code != null ? i.source_code
          : (i.source && i.source.key != null ? i.source.key : '')));
    var vid = i.vodId != null ? i.vodId
      : (i.vod_id != null ? i.vod_id : (i.id != null ? i.id : ''));
    return { sourceKey: String(sc), vodId: String(vid) };
  }
  // 「源 + 影片」规范标识：item 与 result 都适用（兼容 source_code/sourceCode/sourceKey、
  // vod_id/vodId/id 多种命名）。把 onResult 回传的结果对回入队时的内部键，
  // 从而对任意自定义 keyOf 都成立——不再要求 keyOf 能读懂「由结果合成的对象」。
  function identityParts(x) {
    var p = itemParts(x);
    return p.sourceKey + '\u0000' + p.vodId;
  }
  function defaultKeyOf(item) {
    var p = itemParts(item);
    return joinKey(p.sourceKey, p.vodId);
  }

  /**
   * 创建探测队列（闭包持有状态，每次调用得到一个独立队列）。
   *
   * deps 契约：
   *   run(items, onResult, signal): Promise<void>   必填，执行一批探测；
   *     逐条通过 onResult({ sourceKey, vodId, height?, error? }) 回传结果。
   *     本模块不发起请求，run 由调用方注入（便于单测与复用）。
   *   concurrency?: number     同时在飞的请求数，默认 2
   *   batchSize?: number       单批条目上限，默认 8
   *   mergeWindowMs?: number   入队合并窗口 ms，默认 50（别名 coalesceMs 亦可）
   *   timeoutMs?: number       单批看门狗 ms，默认 60000，下限 1000（防误配 0）
   *   keyOf?(item): string     自定义内部键（默认 `${source_code}_${vod_id}`）；
   *     可任意基于 item 字段生成键（如 it => it.key）。结果回传时按「源+影片」规范
   *     标识反查内部键，不要求 keyOf 能读得懂结果对象。
   *   setTimeout?/clearTimeout?: (高级/测试钩子) 注入计时器，默认全局 setTimeout/clearTimeout。
   *
   * 返回 { push(items, onStart?), cancel(keys) }：
   *   push  → Promise<Record<internalKey, result>>，空入队解析为 {}
   *   cancel(keys) 的键用 keyOf(item) 的结果（也容忍 ':' 分隔的等价键）。
   * result 形状：{ sourceKey, vodId, height?, error? }（无 item 引用，保持纯数据）。
   */
  function createProbeQueue(deps) {
    var d = deps || {};
    var run = d.run;
    var concurrency = Math.max(1, numOr(d.concurrency, 2));
    var batchSize = Math.max(1, numOr(d.batchSize, 8));
    var mergeWindowMs = Math.max(0, numOr(d.mergeWindowMs != null ? d.mergeWindowMs : d.coalesceMs, 50));
    var timeoutMs = Math.max(1000, numOr(d.timeoutMs, 60000));
    var keyOf = (typeof d.keyOf === 'function') ? d.keyOf : defaultKeyOf;
    var setTimeoutFn = (typeof d.setTimeout === 'function')
      ? d.setTimeout : function (fn, ms) { return setTimeout(fn, ms); };
    var clearTimeoutFn = (typeof d.clearTimeout === 'function')
      ? d.clearTimeout : function (id) { clearTimeout(id); };

    function numOr(v, fallback) {
      var n = Number(v);
      return (v == null || !isFinite(n)) ? fallback : n;
    }

    // 结果 → 内部 key 的兜底：构造一个「等价于 item」的对象交给 keyOf。
    // 主路径走 identityToKey 反查（见 onResult），这里只处理未匹配到入队项的结果。
    function resultKey(result) {
      var p = itemParts(result || {});
      return keyOf({
        key: joinKey(p.sourceKey, p.vodId),
        source_code: p.sourceKey, sourceCode: p.sourceKey, sourceKey: p.sourceKey,
        source: { key: p.sourceKey },
        vod_id: p.vodId, vodId: p.vodId, id: p.vodId
      });
    }
    function cancelled(item) {
      var p = itemParts(item);
      return { sourceKey: p.sourceKey, vodId: p.vodId, error: '探测已取消' };
    }
    function failed(item, message) {
      var p = itemParts(item);
      return { sourceKey: p.sourceKey, vodId: p.vodId, error: message };
    }

    var pending = new Map();      // key -> item（待发）
    var known = new Map();        // key -> item（在飞或已入队；cancel 据此构造结论）
    var waiters = new Map();      // key -> Array<resolve>（重复入队共享）
    var startHooks = new Map();   // key -> Array<onStart>
    var identityToKey = new Map();// 规范标识 -> 内部键（把 result 对回 keyOf(item)）
    var active = 0;
    var timer = null;

    function settle(key, result) {
      known.delete(key);
      startHooks.delete(key);
      // 清理该 key 对应的规范标识映射，避免长期累积与迟到结果串台
      if (identityToKey.size) {
        var stale = [];
        identityToKey.forEach(function (v, k) { if (v === key) stale.push(k); });
        for (var s = 0; s < stale.length; s++) identityToKey.delete(stale[s]);
      }
      var list = waiters.get(key);
      if (!list) return;          // 被取消 / 已收尾：结果丢弃
      waiters.delete(key);
      for (var i = 0; i < list.length; i++) list[i](result);
    }

    function schedule() {
      if (timer !== null) return;
      timer = setTimeoutFn(dispatch, mergeWindowMs);
    }

    function dispatch() {
      timer = null;
      while (active < concurrency && pending.size > 0) {
        var entries = Array.from(pending.entries()).slice(0, batchSize);
        var keys = [], items = [];
        for (var j = 0; j < entries.length; j++) {
          pending.delete(entries[j][0]);
          keys.push(entries[j][0]);
          items.push(entries[j][1]);
        }

        // onStart 去重后各回调一次：一个 push 的多个键共用一个回调只触发一次；
        // 同一个键被两处入队时，两边的 onStart 都要通知到。
        var hooks = [], seen = new Set();
        for (var k = 0; k < keys.length; k++) {
          var hl = startHooks.get(keys[k]);
          if (!hl) continue;
          startHooks.delete(keys[k]);
          for (var m = 0; m < hl.length; m++) {
            if (seen.has(hl[m])) continue;
            seen.add(hl[m]);
            hooks.push(hl[m]);
          }
        }
        for (var n = 0; n < hooks.length; n++) {
          try { hooks[n](); } catch (e) { /* 调用方 hook 异常不影响队列 */ }
        }

        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        active += 1;
        startBatch(keys, items, controller ? controller.signal : undefined, controller);
      }
    }

    function startBatch(keys, items, signal, controller) {
      var answered = new Set();
      var itemByKey = {};
      for (var i = 0; i < keys.length; i++) itemByKey[keys[i]] = items[i];

      var onResult = function (result) {
        if (!result) return;
        // 主路径：按「源+影片」规范标识反查入队时的内部键，对任意自定义 keyOf 都成立
        var key = identityToKey.get(identityParts(result));
        if (key == null) key = resultKey(result); // 兜底：结果未匹配任何入队项
        answered.add(key);
        settle(key, result);
      };

      (async function () {
        try {
          var runPromise;
          try {
            runPromise = Promise.resolve(run(items, onResult, signal));
          } catch (err) {
            runPromise = Promise.reject(err);
          }
          // 看门狗先于 run 结束时，run 可能仍在后台抛错：提前挂 catch 防 unhandled rejection
          runPromise.catch(function () {});

          var watchdogId = null;
          var watchdog = new Promise(function (_, reject) {
            watchdogId = setTimeoutFn(function () { reject(new Error('探测超时')); }, timeoutMs);
          });
          watchdog.catch(function () {});
          try {
            await Promise.race([runPromise, watchdog]);
          } finally {
            if (watchdogId !== null) clearTimeoutFn(watchdogId);
          }
          // 服务端提前关流 / 条目被过滤：没回结果的必须收尾，否则调用方永远 pending
          for (var a = 0; a < keys.length; a++) {
            if (answered.has(keys[a])) continue;
            settle(keys[a], cancelled(itemByKey[keys[a]]));
          }
        } catch (err) {
          var isTimeout = !!(err && err.message === '探测超时');
          if (isTimeout && controller) {
            try { controller.abort(); } catch (e) { /* noop */ }
          }
          var message = isTimeout ? '探测超时' : '探测失败';
          for (var b = 0; b < keys.length; b++) {
            if (answered.has(keys[b])) continue;
            settle(keys[b], failed(itemByKey[keys[b]], message));
          }
        } finally {
          active -= 1;
          if (pending.size > 0) schedule();
        }
      })();
    }

    function waitFor(key) {
      return new Promise(function (resolve) {
        var list = waiters.get(key);
        if (list) list.push(resolve);
        else waiters.set(key, [resolve]);
      });
    }

    return {
      push: function (items, onStart) {
        var arr = Array.isArray(items) ? items : [];
        var unique = new Map();
        for (var i = 0; i < arr.length; i++) {
          var key = keyOf(arr[i]);
          if (!unique.has(key)) unique.set(key, arr[i]);
        }
        var waits = [];
        var waitKeys = [];
        unique.forEach(function (item, key) {
          waits.push(waitFor(key));
          waitKeys.push(key);
          identityToKey.set(identityParts(item), key);
          if (typeof onStart === 'function') {
            var hooks = startHooks.get(key);
            if (hooks) hooks.push(onStart);
            else startHooks.set(key, [onStart]);
          }
          // 已在队列或在飞：只挂等待，不重复发请求
          if (pending.has(key) || known.has(key)) return;
          pending.set(key, item);
          known.set(key, item);
        });
        if (pending.size > 0) schedule();

        return Promise.all(waits).then(function (results) {
          // results 与 waitKeys 一一对应：settle(该 key) 就是解析对应 waiter 的唯一入口，
          // 因此直接用入队时的键，不依赖结果对象能被 keyOf 反算。
          var out = {};
          for (var j = 0; j < results.length; j++) out[waitKeys[j]] = results[j];
          return out;
        });
      },

      cancel: function (keys) {
        var arr = Array.isArray(keys) ? keys : [];
        for (var i = 0; i < arr.length; i++) {
          var raw = String(arr[i]);
          // 容忍调用方用 qualityKey 的 ':' 形式传键：还原成内部 '_' 形式
          var alt = raw.replace(':', '_');
          var resolved = known.has(raw) ? raw : (known.has(alt) ? alt : null);
          var key = resolved || raw;
          var item = known.get(key);
          pending.delete(key);
          startHooks.delete(key);
          if (!item) continue;
          settle(key, cancelled(item));
        }
      }
    };
  }

  g.WDTVProbeQueue = {
    createProbeQueue: createProbeQueue,
    defaultKeyOf: defaultKeyOf
  };
})(typeof window !== 'undefined' ? window : globalThis);
