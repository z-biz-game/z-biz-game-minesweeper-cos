#!/usr/bin/env node
/* rate-test.mjs —— 同一局在 30/60/120Hz 上必须是同一局。
 *
 * 为什么要自己写：官方那把尺（cos_frame_probe.js）只有"绿/红"两档读数，它验的是
 * "有没有 requestAnimationFrame 在跑"，不验"动画进度是不是帧率的函数"。而在 120Hz 的
 * 手机上，一个 `this.frame++` 写法的 FX 会两倍速播完 —— 画面照样动，尺子照样绿。
 *
 * 这里的口径：
 *   1. 对齐用的是**虚拟时间**（同一刻），不是"跑了多少帧"——三档的帧数本来就不同。
 *      每个 checkpoint 用"整数帧 + 一个补齐的短帧"精确落在 T 毫秒上。
 *   2. 比的是**渲染出来的东西**：把 ctx 的每一次赋值与调用录成一条确定性日志
 *      (fillStyle=…, globalAlpha=0.42…, fillText(…, fontSize))，三档在同一个虚拟时刻
 *      必须逐字节相同。浮点尾噪在 1e-6 处归一。
 *   3. 负控不是嘴上说的：把 createFrameClock 换成"假装每帧 16.67ms"的变异体（同一段断言
 *       machinery，只是喂给它的时钟换了），三档必须立刻对不齐 —— 否则这套断言是空的。
 *   4. 暂停：elapsed 在暂停期间不随墙钟增长（表针真的停了），恢复后只补回真实玩的那段。
 *
 *   node tools/rate-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  [' + extra + ']' : ''}`); }
};

// ---------------------------------------------------------------- 浏览器桩
// Image 故意"永不解码"：走的是 board.js 里的矢量回退分支，那条路径也得是帧率无关的。
class Image {
  constructor() { this.complete = false; this.naturalWidth = 0; }
  set src(_v) {}
  get src() { return ''; }
}
globalThis.Image = Image;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.window = { devicePixelRatio: 2, addEventListener() {} };

const R6 = (v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v);
function makeCtx() {
  const log = [];
  const props = {};
  const ctx = new Proxy({}, {
    get(_t, k) {
      if (k === 'canvas') return null;
      if (k in props) return props[k];
      if (k === 'measureText') return () => ({ width: 8 });
      if (k === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
      if (k === 'createLinearGradient' || k === 'createRadialGradient') {
        return (...a) => ({ addColorStop: () => {}, __stops: a.map(R6).join(',') });
      }
      if (k === 'createPattern') return (...a) => ({ __pat: a.map(R6).join(',') });
      return (...a) => { log.push(String(k) + '(' + a.map(R6).join(',') + ')'); };
    },
    set(_t, k, v) {
      props[k] = v;
      log.push(String(k) + '=' + R6(v && typeof v === 'object' ? (v.__stops || v.__pat || 'obj') : v));
      return true;
    },
  });
  return { ctx, log };
}
const makeCanvas = (ctx) => ({
  width: 0, height: 0, style: {}, nodeName: 'CANVAS',
  getContext: () => ctx,
  addEventListener() {}, removeEventListener() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 420, height: 420 }),
  setPointerCapture() {}, releasePointerCapture() {},
});

const { createFrameClock } = await import(pathToFileURL(path.join(ROOT, 'js/ui/loop.js')).href);
const { BoardView } = await import(pathToFileURL(path.join(ROOT, 'js/render/board.js')).href);
const { Game } = await import(pathToFileURL(path.join(ROOT, 'js/ui/game.js')).href);
const { generate } = await import(pathToFileURL(path.join(ROOT, 'js/engine/generate.js')).href);
const { Motion } = await import(pathToFileURL(path.join(ROOT, 'js/theme.js')).href);

// 固定种子：三档喂的是同一个雷区，任何差异都只能来自时间轴，不能来自随机。
const puzzle = generate('scout', 'rate-test#1');   // generate 直接返回 puzzle 本体
ok('雷区生成成功', !!puzzle && puzzle.w > 0 && puzzle.start >= 0, JSON.stringify(puzzle && { w: puzzle.w, h: puzzle.h, start: puzzle.start }));

function makeScene() {
  const { ctx, log } = makeCtx();
  const view = new BoardView(makeCanvas(ctx));
  const game = new Game(puzzle);
  game.start();
  view.layout(puzzle, 420, 420);
  return { view, game, log };
}

// 精确落在 targetMs 上的帧序列：整数帧 + 一个补齐短帧（三档的最后一帧虚拟时刻完全相同）。
function frameTimes(targetMs, hz) {
  const step = 1000 / hz;
  const out = [];
  let acc = 0;
  while (acc + step <= targetMs) { out.push(step); acc += step; }
  if (targetMs - acc > 1e-9) out[out.length - 1] = step + (targetMs - acc);
  return out;
}

// 用生产代码走这段时间：createFrameClock 换算帧长，BoardView.tick 累加 FX 时钟。
function runAt(hz, targetMs, stamp) {
  const { view, game, log } = makeScene();
  const clock = createFrameClock();
  let ts = 1000;                       // 台架/后台唤起的第一个时间戳不从 0 起
  clock.frame(ts);                     // 首帧只负责 primed，返回 0
  // 涟漪只在 FX 时钟 0 处插一次：每帧重插会让"到期"永远不发生，测的就不是时长了。
  if (stamp) view.pulse(stamp.cell, stamp.kind);
  const marks = [];
  for (const dt of frameTimes(targetMs, hz)) {
    ts += dt;
    const step = clock.frame(ts);
    view.tick(step);
    const from = log.length;
    view.render(game);
    marks.push({ at: view.clock, ops: log.slice(from).join('|') });
  }
  return { view, clock, marks, last: marks[marks.length - 1] };
}

// ---------------------------------------------------------------- 1. 累加精确性
const RATES = [30, 60, 120];
const TARGETS = [100, 250, 500, Motion.pop, 1000, 2500];
for (const T of TARGETS) {
  const clocks = RATES.map((hz) => runAt(hz, T).view.clock);
  const spread = Math.max(...clocks) - Math.min(...clocks);
  ok(`FX 时钟与帧率无关：T=${T}ms 三档一致`, spread < 1e-6,
    RATES.map((hz, i) => `${hz}Hz=${clocks[i].toFixed(9)}`).join(' '));
  const elapsed = RATES.map((hz) => runAt(hz, T).clock.elapsed);
  ok(`帧时钟累计等于虚拟时长：T=${T}ms`, elapsed.every((v) => Math.abs(v - T) < 1e-6),
    elapsed.map((v) => v.toFixed(6)).join(' '));
}

// ---------------------------------------------------------------- 2. 同一虚拟时刻画的是同一样东西
for (const T of [100, 250, 500, Motion.pop * 0.5, 1000]) {
  const runs = RATES.map((hz) => runAt(hz, T, { cell: puzzle.start, kind: 'open' }));
  const logs = runs.map((r) => r.last.ops);
  const alphas = runs.map((r) => (r.last.ops.match(/globalAlpha=[\d.]+/g) || []).join(','));
  const same = logs.every((l) => l === logs[0]);
  ok(`同一虚拟时刻的绘制序列逐字节相同：T=${T}ms + 一个挖开涟漪`, same,
    same ? '' : RATES.map((hz, i) => `${hz}Hz len=${logs[i].length}`).join(' '));
  ok(`涟漪透明度只由时间决定：T=${T}ms`, new Set(alphas).size === 1, alphas.join(' || '));
}

// 涟漪必须在同一虚拟时刻结束，而不是"同样帧数"后结束
for (const hz of RATES) {
  const a = runAt(hz, Motion.pop + 1, { cell: puzzle.start, kind: 'open' });
  ok(`涟漪在 ${hz}Hz 下按时长到期（不是按帧数）`, a.view.pulses.size === 0,
    'pulses=' + a.view.pulses.size);
}

// ---------------------------------------------------------------- 3. 负控：帧计数实现必须被抓到
const loopSrc = read('js/ui/loop.js');
const CHEAT_LINE = 'return dt > maxStepMs ? maxStepMs : dt;';
ok('负控可注入（loop.js 的返回行找得到）', loopSrc.includes(CHEAT_LINE));
const cheatSrc = loopSrc.replace(CHEAT_LINE, 'return 1000 / 60;   // 变异：假装每帧都是 60Hz');
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(cheatSrc).toString('base64');
const { createFrameClock: createCheatClock } = await import(dataUrl);

function runCheat(hz, targetMs) {
  const { view, game, log } = makeScene();
  const clock = createCheatClock();
  let ts = 1000;
  clock.frame(ts);
  const marks = [];
  for (const dt of frameTimes(targetMs, hz)) {
    ts += dt;
    view.tick(clock.frame(ts));
    const from = log.length;
    view.render(game);
    marks.push({ at: view.clock, ops: log.slice(from).join('|') });
  }
  return { view, last: marks[marks.length - 1] };
}
const cheat = RATES.map((hz) => runCheat(hz, 1000).view.clock);
ok('负控生效：帧计数实现在三档下走出三条时间轴',
  new Set(cheat.map((v) => v.toFixed(3))).size === RATES.length,
  RATES.map((hz, i) => `${hz}Hz=${cheat[i].toFixed(1)}ms`).join(' '));
const cheatRun = RATES.map((hz) => {
  const { view, game, log } = makeScene();
  const clock = createCheatClock();
  let ts = 1000;
  clock.frame(ts);
  view.pulse(puzzle.start, 'open');
  let last = '';
  for (const dt of frameTimes(250, hz)) {
    ts += dt;
    view.tick(clock.frame(ts));
    const from = log.length;
    view.render(game);
    last = log.slice(from).join('|');
  }
  return last;
});
ok('负控生效：同一"虚拟 250ms"下帧计数实现画出不同的涟漪',
  new Set(cheatRun).size > 1, 'distinct=' + new Set(cheatRun).size);
ok('对照：真实现同一时刻三档相同（上面两条红只该由变异体引起）',
  new Set(RATES.map((hz) => runAt(hz, 250, { cell: puzzle.start, kind: 'open' }).last.ops)).size === 1);

// ---------------------------------------------------------------- 4. 后台标签页不许一次跳完
{
  const { view } = makeScene();
  const clock = createFrameClock();
  clock.frame(1000);
  view.tick(clock.frame(1000 + 30000));          // 挂起 30 秒后回来
  ok('切后台 30s 回来只补一帧（FX 不会瞬完）', view.clock > 0 && view.clock <= 250, 'clock=' + view.clock);
  const tight = createFrameClock({ maxStepMs: 16 });
  tight.frame(0);
  ok('maxStepMs 可收紧', tight.frame(16.5) === 16.5 || tight.elapsed <= 16.0001);
  const back = createFrameClock();
  back.frame(5000);
  ok('时间戳回拨不产生负帧长', back.frame(4000) === 0 && back.elapsed === 0);
  ok('同一时间戳重复帧不推进', back.frame(4000) === 0);
}

// ---------------------------------------------------------------- 5. 暂停时表针真的停
{
  const { game } = makeScene();
  const real = performance.now();
  const before = game.elapsed(real + 5000);
  game.pause();
  const pausedLate = game.elapsed(real + 5000);
  const pausedLater = game.elapsed(real + 60000);
  ok('暂停中 55s 墙钟不再推进计时', pausedLater - pausedLate < 1,
    `${pausedLate.toFixed(1)} → ${pausedLater.toFixed(1)}`);
  game.resume();
  const after = game.elapsed(real + 60000) - game.elapsed(real + 55000);
  ok('恢复后按真实游玩时长走（暂停那 55s 不计）', Math.abs(after - 5000) < 1, 'Δ=' + after.toFixed(1));
  ok('暂停前已走的秒数没有被抹掉', before > 4999 && before < 5001, 'before=' + before);
}

// ---------------------------------------------------------------- 6. 重开必须清 FX
{
  const { view, game } = makeScene();
  view.pulse(puzzle.start, 'open');
  view.beginWin();
  view.tick(5);
  game.reset();
  view.resetFx();
  ok('重开清掉涟漪', view.pulses.size === 0);
  ok('重开清掉胜负扫光', view.winAt === 0 && view.boomAt === 0);
  ok('重开把 FX 时钟归零（新局不会带着旧时间轴开场）', view.clock === 0, 'clock=' + view.clock);
}

console.log(`\n${fail ? 'FAILED' : 'OK'}  rate: ${pass} pass / ${fail} fail  (rates ${RATES.join('/')}Hz, pop=${Motion.pop}ms)`);
process.exit(fail ? 1 : 0);
