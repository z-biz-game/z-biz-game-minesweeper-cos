#!/usr/bin/env node
/* audio-test.mjs —— "静音开关"绿了不等于静音：gain=0 只是把声音拧小，节点照样一个个建。
 *
 * 改动前 setEnabled() 做的事是 `master.gain.value = 0`：一局几百个音效仍然
 * createOscillator + createGain + start + stop 排进时间线，而已经排好队的长音
 * （win 是 5 连音、boom 是 0.6s）在"静音"之后仍然会响完 —— 那是音量旋钮，不是静音。
 * 现在要的是：上下文挂起 + 静音期间一个振荡器都不许生成 + unlock() 不许把静音唤醒。
 *
 *   node tools/audio-test.mjs
 */
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) pass++;
  else { fail++; console.log(`  FAIL  ${name}${extra ? '  [' + extra + ']' : ''}`); }
};

function makeAc({ suspendable = true } = {}) {
  const stats = { osc: 0, gain: 0, suspend: 0, resume: 0, starts: 0 };
  const node = () => ({
    connect: (n) => n, disconnect() {},
    frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
    gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
    type: '', start() { stats.starts++; }, stop() {},
  });
  class AC {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = node(); }
    createGain() { stats.gain++; return node(); }
    createOscillator() { stats.osc++; return node(); }
    suspend() { stats.suspend++; this.state = 'suspended'; return Promise.resolve(); }
    resume() { stats.resume++; this.state = 'running'; return Promise.resolve(); }
  }
  if (!suspendable) delete AC.prototype.suspend;
  globalThis.window = { AudioContext: AC };
  return { AC, stats };
}

const fresh = (() => { let i = 0; return async () => {
  const { audio } = await import(pathToFileURL(path.join(ROOT, 'js/audio/synth.js')).href + '?v=' + (++i));
  return audio;
}; })();

// ---------------------------------------------------------------- 1. 真静音
{
  const { stats } = makeAc();
  const audio = await fresh();
  audio.unlock();                                   // 首次手势建上下文（与原实现同一条路径）
  audio.dig();
  const before = stats.osc;
  ok('有声时会生成振荡器', before >= 1, 'osc=' + before);

  audio.setEnabled(false);
  ok('静音挂起上下文（suspend 被调用）', stats.suspend === 1, 'suspend=' + stats.suspend);
  ok('静音后状态真是 suspended', stats.resume === 0);

  const atMute = stats.osc;
  for (let i = 0; i < 40; i++) { audio.dig(); audio.flag(); audio.chord(); }
  audio.flood(32); audio.win(); audio.boom(); audio.hint(); audio.error();
  ok('静音期间零新节点', stats.osc === atMute, `osc ${atMute} → ${stats.osc}`);
  ok('静音期间零 start()', stats.starts === before, `starts=${stats.starts}`);

  audio.setEnabled(true);
  ok('取消静音会 resume 上下文', stats.resume === 1, 'resume=' + stats.resume);
  audio.dig();
  ok('取消静音后声音回来', stats.osc > atMute, `osc ${atMute} → ${stats.osc}`);
}

// ---------------------------------------------------------------- 2. 静音不许被"首次手势"偷偷打开
{
  const { stats } = makeAc();
  const audio = await fresh();
  audio.setEnabled(false);
  const s0 = stats.suspend;
  audio.unlock();
  audio.unlock();
  ok('静音下 unlock 不 resume（否则点一下就又响了）', stats.resume === 0, 'resume=' + stats.resume);
  ok('静音下 unlock 不重复 suspend', stats.suspend === s0);
  audio.dig();
  ok('静音下 unlock 也不生成节点', stats.osc === 0, 'osc=' + stats.osc);
}

// ---------------------------------------------------------------- 3. 缺 suspend 的浏览器（headless 桩就是这种）
{
  const { stats } = makeAc({ suspendable: false });
  const audio = await fresh();
  let threw = null;
  try {
    audio.setEnabled(false);
    audio.dig();
    audio.setEnabled(true);
    audio.dig();
  } catch (e) { threw = e.message; }
  ok('没有 suspend() 时不抛（旧 Safari / 台架桩）', threw === null, String(threw));
  ok('没有 suspend() 时静音仍然成立（零节点）', stats.osc === 1, 'osc=' + stats.osc);
}

// ---------------------------------------------------------------- 4. 完全没有 WebAudio
{
  globalThis.window = {};
  const audio = await fresh();
  let threw = null;
  try { audio.unlock(); audio.setEnabled(false); audio.dig(); audio.setEnabled(true); audio.win(); }
  catch (e) { threw = e.message; }
  ok('没有 AudioContext 时整局不抛', threw === null, String(threw));
  ok('开关状态仍然可读（UI 不会自相矛盾）', audio.isEnabled() === true && audio.muted === false);
}

// ---------------------------------------------------------------- 5. toggleMute 是真值翻转，不是计数器
{
  makeAc();
  const audio = await fresh();
  const seq = [audio.toggleMute(), audio.toggleMute(), audio.toggleMute()];
  ok('toggleMute 逐次翻转', seq[0] === true && seq[1] === false && seq[2] === true, JSON.stringify(seq));
  ok('muted 与 isEnabled 互斥', audio.muted === !audio.isEnabled());
}

console.log(`\n${fail ? 'FAILED' : 'OK'}  audio: ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
