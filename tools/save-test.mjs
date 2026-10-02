#!/usr/bin/env node
/* save-test.mjs —— 存档坏掉时"坏一条丢一条"，不是"坏一处丢全部"。
 *
 * 为什么要有这个文件：Store.load() 以前是一段 try/catch + 三层展开合并。JSON.parse 过了就一路
 * 直通到 UI，而类型完全没人管：`resume.ink` 变成一个数字，`rleDecode` 里 `pairs.length` 就是
 * undefined，读档直接抛 TypeError；`cells` 变成 1e9，`new Uint8Array(1e9)` 是 RangeError —
 * 两者都发生在启动路径上，于是"一次截断的写盘 = 打不开的游戏"。更糟的是老代码里
 * `settings: {sound: "false"}` 这种字符串会原样存活，而 `"false"` 在 if 里是真值。
 *
 * 现在分两段：sanitize() 逐条验记录（坏一条丢一条），resume() 才真的展开 RLE，
 * 展开仍包在 try 里。这里既有真存档回环，也有四类垃圾样本，还有一条"旧写法确实会炸"的对照。
 *
 *   node tools/save-test.mjs
 */
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  [' + extra + ']' : ''}`); }
};

// localStorage 桩：Store 在模块加载时就读一次，所以必须先挂再 import。
const kv = new Map();
globalThis.localStorage = {
  getItem: (k) => (kv.has(k) ? kv.get(k) : null),
  setItem: (k, v) => { kv.set(k, String(v)); },
  removeItem: (k) => { kv.delete(k); },
};
const KEY = 'minesweeper.save.v1';
// 每次换 specifier 骗过 ESM 缓存：Store 在模块加载时就读了 localStorage，
// 换个样本就得要一个全新的实例（序号而不是随机数 —— 失败要能复现）。
let instance = 0;
const fresh = async () => {
  const { Store } = await import(pathToFileURL(path.join(ROOT, 'js/store.js')).href + '?v=' + (++instance));
  return Store;
};
const put = (obj) => kv.set(KEY, typeof obj === 'string' ? obj : JSON.stringify(obj));

const GOOD_RESUME = {
  seed: 'scout#7', tier: 'scout', elapsedMs: 12345, cells: 6, moves: 4, hints: 1,
  ink: [0, 4, 1, 2], at: 1700000000000,
};
const GOOD = {
  settings: { sound: false, autoFlag: true, question: true, reduceMotion: false },
  best: { scout: { ms: 4200, hints: 0, moves: 9, size: 56, at: 1 }, trainee: { ms: 9000, hints: 1, moves: 20, size: 120, at: 2 } },
  daily: { lastKey: '2026-10-01', streak: 5, solved: ['2026-09-30', '2026-10-01'] },
  totals: { solved: 7, hints: 3, ms: 100000 },
  resume: GOOD_RESUME,
};

// ---------------------------------------------------------------- 0. 好存档必须原样回来
{
  put(GOOD);
  const S = await fresh();
  ok('好存档 settings 保住', S.setting('sound') === false && S.setting('question') === true);
  ok('好存档 best 两级都在', S.best('scout')?.ms === 4200 && S.best('trainee')?.ms === 9000);
  ok('好存档 daily 连续天数保住', S.data.daily.streak === 5 && S.dailySolved('2026-10-01'));
  ok('好存档 totals 保住', S.data.totals.solved === 7 && S.data.totals.ms === 100000);
  const r = S.resume();
  ok('好存档能续上', !!r && r.board.length === 6);
  ok('RLE 展开正确', !!r && [...r.board].join('') === '000011', r && [...r.board].join(''));
}

// ---------------------------------------------------------------- 1. 整块是垃圾
for (const [name, blob] of [['空串', ''], ['null', 'null'], ['数组', '[1,2,3]'],
  ['字符串', '"hello"'], ['截断的 JSON', '{"settings":{"sound":tr'], ['数字', '42']]) {
  put(blob);
  let threw = null, S = null;
  try { S = await fresh(); } catch (e) { threw = e.message; }
  ok(`垃圾整块(${name})不抛`, threw === null, String(threw));
  if (S) {
    ok(`垃圾整块(${name})回到默认`, S.setting('sound') === true && S.resume() === null
      && Object.keys(S.data.best).length === 0 && S.data.daily.streak === 0);
  }
}

// ---------------------------------------------------------------- 2. 少字段
{
  const noInk = { ...GOOD, resume: { ...GOOD_RESUME } };
  delete noInk.resume.ink;
  put(noInk);
  const S = await fresh();
  ok('存档少 ink：这一局续不上', S.resume() === null);
  ok('存档少 ink：设置还在', S.setting('question') === true);
  ok('存档少 ink：纪录还在', S.best('scout')?.ms === 4200);
  ok('存档少 ink：连续天数还在', S.data.daily.streak === 5);

  const noCells = { ...GOOD, resume: { ...GOOD_RESUME } };
  delete noCells.resume.cells;
  put(noCells);
  ok('存档少 cells：只丢这一局', (await fresh()).resume() === null);
}

// ---------------------------------------------------------------- 3. 类型错
{
  put({ ...GOOD, resume: { ...GOOD_RESUME, ink: 42 } });
  let threw = null, S = null;
  try { S = await fresh(); } catch (e) { threw = e.message; }
  ok('ink 是数字：不抛', threw === null, String(threw));
  ok('ink 是数字：只丢存档', S.resume() === null && S.setting('sound') === false);

  put({ ...GOOD, resume: { ...GOOD_RESUME, seed: 7 } });
  ok('seed 是数字：只丢存档', (await fresh()).resume() === null);
  put({ ...GOOD, resume: { ...GOOD_RESUME, moves: '4' } });
  ok('moves 是字符串：只丢存档', (await fresh()).resume() === null);

  put({ ...GOOD, settings: { sound: 'false', autoFlag: 1, question: true } });
  const S2 = await fresh();
  ok('字符串 "false" 不当真', S2.setting('sound') === true, 'got ' + S2.setting('sound'));
  ok('数字 1 不当真', S2.setting('autoFlag') === true && S2.setting('question') === true);

  put({ ...GOOD, best: { scout: 'nope', trainee: GOOD.best.trainee } });
  const S3 = await fresh();
  ok('坏的一条 best 纪录单独丢掉', S3.best('scout') === null);
  ok('其余 best 纪录活着', S3.best('trainee')?.ms === 9000);

  put({ ...GOOD, daily: { lastKey: '2026-13-45', streak: '很多', solved: 5 } });
  const S4 = await fresh();
  ok('非法日期 lastKey 丢掉', S4.data.daily.lastKey === null);
  ok('非数字 streak 回到默认', S4.data.daily.streak === 0);
  ok('非数组 solved 回到默认', Array.isArray(S4.data.daily.solved) && S4.data.daily.solved.length === 0);
  let marked = null, e4 = null;
  try { marked = S4.markDaily('2026-10-02'); } catch (e) { e4 = e.message; }
  ok('脏 solved 下 markDaily 不炸', e4 === null, String(e4));
  ok('markDaily 从零重开计数', marked && marked.isNew === true && marked.streak === 1);
}

// ---------------------------------------------------------------- 4. 数值越界
{
  put({ ...GOOD, resume: { ...GOOD_RESUME, cells: 1e9 } });
  let e5 = null, S5 = null;
  try { S5 = await fresh(); S5.resume(); } catch (e) { e5 = e.constructor.name + ': ' + e.message; }
  ok('cells=1e9 不炸启动', e5 === null, String(e5));
  ok('cells=1e9 只丢存档', S5.resume() === null && S5.best('scout')?.ms === 4200);

  put({ ...GOOD, resume: { ...GOOD_RESUME, cells: -6 } });
  ok('cells 负数被拒', (await fresh()).resume() === null);
  put({ ...GOOD, resume: { ...GOOD_RESUME, elapsedMs: -1 } });
  ok('elapsedMs 负数被拒', (await fresh()).resume() === null);
  put({ ...GOOD, resume: { ...GOOD_RESUME, elapsedMs: 1e15 } });
  ok('elapsedMs 荒谬值被拒', (await fresh()).resume() === null);
  put({ ...GOOD, resume: { ...GOOD_RESUME, ink: [9, 1, 0, 1] } });
  ok('游程值 9（不是 0..3）被拒', (await fresh()).resume() === null);
  put({ ...GOOD, resume: { ...GOOD_RESUME, ink: [0, 0, 1, 2] } });
  ok('游程长度 0 被拒', (await fresh()).resume() === null);
  put({ ...GOOD, resume: { ...GOOD_RESUME, ink: [0, 1, 1, 2, 3] } });
  ok('奇数长度 ink 被拒', (await fresh()).resume() === null);
  put({ ...GOOD, totals: { solved: -3, hints: 1e99, ms: 'x' } });
  const S6 = await fresh();
  ok('负数/NaN/字符串 totals 回默认', S6.data.totals.solved === 0 && S6.data.totals.hints === 0 && S6.data.totals.ms === 0);
}

// ---------------------------------------------------------------- 5. 一条坏记录不该带走 19 条好记录
{
  const best = {};
  for (let i = 0; i < 20; i++) best['tier' + i] = { ms: 1000 + i, hints: 0, moves: 5, size: 40, at: 0 };
  best.tier7 = { ms: NaN, hints: 0, moves: 5, size: 40, at: 0 };
  put({ ...GOOD, best });
  const S7 = await fresh();
  ok('20 条 best 里坏 1 条只丢那 1 条',
    Object.keys(S7.data.best).length === 19 && S7.best('tier7') === null && S7.best('tier6').ms === 1006,
    'kept ' + Object.keys(S7.data.best).length);
}

// ---------------------------------------------------------------- 6. 对照：老写法真的会炸/真的会静默错
{
  // 下面 20 行是改动前的原样实现（try/catch + 三层展开合并 + rleDecode 直接吃 pairs）。
  // 留着它，是为了让"这个闸在测什么"可被反驳：把 sanitize 拆掉，这几条会立刻红。
  const legacyLoad = (parsed) => {
    const base = {
      settings: { sound: true, autoFlag: true, question: false, reduceMotion: false },
      best: {}, daily: { lastKey: null, streak: 0, solved: [] }, resume: null,
      totals: { solved: 0, hints: 0, ms: 0 },
    };
    return {
      ...base, ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}) },
      daily: { ...base.daily, ...(parsed.daily || {}) },
      totals: { ...base.totals, ...(parsed.totals || {}) },
    };
  };
  const legacyDecode = (pairs, len) => {
    const b = new Uint8Array(len);
    let i = 0;
    for (let p = 0; p < pairs.length; p += 2) {
      const v = pairs[p]; const n = pairs[p + 1];
      for (let k = 0; k < n && i < len; k++) b[i++] = v;
    }
    return b;
  };
  const boom = (fn) => { try { fn(); return null; } catch (e) { return e.constructor.name; } };

  ok('对照①：老代码遇 ink:null 抛 TypeError', boom(() => legacyDecode(null, 6)) === 'TypeError');
  put({ ...GOOD, resume: { ...GOOD_RESUME, ink: null } });
  ok('新代码遇 ink:null 只是续不上', (await fresh()).resume() === null);

  // node 22 上 new Uint8Array(1e12) 不抛（保留地址空间，实测 8ms 就"分配"完），Chrome 会抛
  // RangeError。所以这里断言的不是"炸"，而是"存档里一个数字就能决定本局要做多少字节的工作"：
  // 老代码对 cells/run 长度都没有上界，新代码在分配之前就拒。
  const timed = (fn) => { const t0 = process.hrtime.bigint(); const v = fn(); return [Number(process.hrtime.bigint() - t0) / 1e6, v]; };
  const [ms1e6] = timed(() => legacyDecode([0, 1e6], 1e6));
  const [ms1e7] = timed(() => legacyDecode([0, 1e7], 1e7));
  ok('对照②：老代码的工作量由存档数字线性决定（1e6→1e7）', ms1e7 > ms1e6 * 3,
    `${ms1e6.toFixed(1)}ms → ${ms1e7.toFixed(1)}ms`);
  put({ ...GOOD, resume: { ...GOOD_RESUME, cells: 1e9, ink: [0, 1e9] } });
  const S2b = await fresh();
  const [msNew, got] = timed(() => S2b.resume());
  ok('新代码在分配前就拒绝，成本与存档数字无关', got === null && msNew < 2, msNew.toFixed(2) + 'ms');

  ok('对照③：老代码遇 ink:{} 静默给出全 0 盘（假存档读成"一格没挖"）',
    [...legacyDecode({}, 6)].join('') === '000000');
  put({ ...GOOD, resume: { ...GOOD_RESUME, ink: {} } });
  ok('新代码把 ink:{} 判成坏记录', (await fresh()).resume() === null);

  const legacyDaily = legacyLoad({ daily: { solved: 5 } });
  ok('对照④：老代码下 markDaily 直接抛',
    boom(() => legacyDaily.daily.solved.includes('2026-10-02')) === 'TypeError');
  put({ ...GOOD, daily: { lastKey: 'x', streak: 0, solved: 5 } });
  const S8 = await fresh();
  let e8 = null;
  try { S8.markDaily('2026-10-02'); } catch (e) { e8 = e.message; }
  ok('新代码下 markDaily 不抛', e8 === null, String(e8));

  const legacySettings = legacyLoad({ settings: { sound: 'false' } });
  ok('对照⑤：老代码里 "false" 是真值（静音开关说谎）', !!legacySettings.settings.sound === true);
  put({ ...GOOD, settings: { sound: 'false' } });
  ok('新代码不把 "false" 当开', (await fresh()).setting('sound') === true);

  const legacyBest = legacyLoad({ best: { scout: 'nope' } });
  legacyBest.save = () => {};
  let better = null;
  try { better = (legacyBest.best.scout.hints < 0); } catch (e) { better = 'throw'; }
  ok('对照⑥：老代码下坏 best 记录让新成绩永远写不进（静默失效）',
    better === 'throw' || better === false, String(better));
  put({ ...GOOD, best: { scout: 'nope' } });
  const S9 = await fresh();
  ok('新代码下同一级能重新写下纪录',
    S9.recordBest('scout', { ms: 1000, hints: 0, moves: 3, size: 40 }) === true && S9.best('scout').ms === 1000);
}

// ---------------------------------------------------------------- 7. 写盘失败不许崩
{
  const S = await fresh();
  const real = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  let e7 = null;
  try { S.setSetting('sound', false); S.saveResume({ originSeed: 'a', tier: 'scout', w: 7, h: 7 }, [0, 1], 10, { moves: 1, hints: 0 }); }
  catch (e) { e7 = e.message; }
  globalThis.localStorage.setItem = real;
  ok('配额爆掉时游戏照常可玩', e7 === null, String(e7));
  ok('写失败后内存态仍然自洽', S.setting('sound') === false);
}

console.log(`\n${fail ? 'FAILED' : 'OK'}  save: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
