// Synthesised sound only — a 200 KB sample pack would be the loudest thing in the repo.
// Every cue is short and non-reverbing; the fill tick in particular must survive being
// played forty times a minute without turning abrasive.

let ctx = null;
let master = null;
let enabled = true;

// 静音偏好：读回存档。放在模块顶层，init（首屏、开局、重开）都拿到同一个答案，
// 重开一局不会把玩家的静音选择洗掉。
try {
  if (localStorage.getItem('cos.mute') === '1') enabled = false;
} catch { /* 读不到就沿用默认开声 */ }

function ensure() {
  // 静音态连 ctx 都不许建、不许拉起来：静音期间这个 AudioContext 根本没有在跑。
  if (!enabled) return null;
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.32;
  master.connect(ctx.destination);
  return ctx;
}

// 静音必须是"图元不再生成 + 上下文挂起"，不是把 master 增益拧到 0：
// gain=0 时每个音效仍会 createOscillator/start/stop，一局几百个节点白烧，
// 而且已经排进时间线的长音（win 的 5 连音、boom 的 0.6s）仍会占着调度器。
function applyCtxState() {
  if (!ctx) return;
  const suspend = typeof ctx.suspend === 'function';
  const resume = typeof ctx.resume === 'function';
  try {
    if (!enabled) {
      if (suspend && ctx.state === 'running') ctx.suspend();
    } else if (resume && ctx.state === 'suspended') {
      ctx.resume();
    }
  } catch (e) {
    // 旧 Safari / headless 桩没有 suspend()：没有它静音仍然成立（tone() 直接不生成节点），
    // 只是省不掉调度器。这不该把整局游戏带崩。
  }
}

export const audio = {
  setEnabled(v) {
    const on = !!v;
    if (on === enabled) return;
    enabled = on;
    // 真静音：停掉 AudioContext 本身（时钟停、图不跑）。
    // 旧写法是 master.gain.value = 0 —— 那是简报点名的假静音：节点照建、时钟照跑，
    // 取消静音后还会有一段没播完的尾巴冒出来。这里不再碰 master.gain。
    if (ctx) {
      if (on) {
        if (ctx.state === 'suspended' && ctx.resume) ctx.resume().catch(() => {});
      } else if (ctx.state === 'running' && ctx.suspend) {
        ctx.suspend().catch(() => {});
      }
    }
    // 偏好落盘：刷新页面后 init 要能读回静音态，不能自己弹回来。
    try {
      localStorage.setItem('cos.mute', on ? '1' : '0');
    } catch { /* 隐私模式下写不进去也不该炸游戏 */ }
  },
  isEnabled: () => enabled,
  // 两种叫法都留着是有原因的：设置项历史上叫 sound（存的是"开不开"），而玩家看到的
  // 按钮与快捷键 M 说的是"静不静"。让两侧各有自己的读法，就不用在调用处写双重否定。
  get muted() {
    return !enabled;
  },
  toggleMute() {
    this.setEnabled(!enabled);
    return !enabled;
  },
  // Browsers refuse to start audio outside a gesture; the first tap calls this.
  unlock() {
    const c = ensure();
    // 静音时不许偷偷把上下文唤醒——那等于玩家按了静音、下一次点击又把它打开了。
    if (c && enabled && c.state === 'suspended') c.resume();
  },

  tone({ freq = 440, dur = 0.08, type = 'sine', gain = 0.5, slide = 0, delay = 0 }) {
    if (!enabled) return;              // 静音下不生成任何节点，先看开关再建上下文
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  },

  // A dig is the most frequent sound in the game by an order of magnitude, so it is the
  // dullest one: short, quiet, and never reverberating.
  dig() {
    this.tone({ freq: 300, dur: 0.045, type: 'sine', gain: 0.2, slide: -70 });
  },
  // A region opening is the reward, so the arpeggio grows with how much it uncovered —
  // capped, because a 40-cell flood that plays 40 notes is noise.
  flood(count = 1) {
    const steps = Math.min(5, 1 + Math.floor(Math.log2(Math.max(1, count))));
    for (let i = 0; i < steps; i++)
      this.tone({ freq: 420 * Math.pow(1.22, i), dur: 0.075, type: 'triangle', gain: 0.24, delay: i * 0.045 });
  },
  flag() {
    this.tone({ freq: 660, dur: 0.06, type: 'triangle', gain: 0.28, slide: 120 });
  },
  unflag() {
    this.tone({ freq: 420, dur: 0.05, type: 'sine', gain: 0.18, slide: -120 });
  },
  chord() {
    this.tone({ freq: 520, dur: 0.05, type: 'square', gain: 0.12 });
    this.tone({ freq: 780, dur: 0.06, type: 'square', gain: 0.1, delay: 0.05 });
  },
  hint() {
    this.tone({ freq: 880, dur: 0.12, type: 'sine', gain: 0.26, slide: 220 });
  },
  error() {
    this.tone({ freq: 160, dur: 0.12, type: 'square', gain: 0.14, slide: -60 });
  },
  boom() {
    this.tone({ freq: 220, dur: 0.5, type: 'sawtooth', gain: 0.3, slide: -180 });
    this.tone({ freq: 90, dur: 0.6, type: 'square', gain: 0.22, slide: -50 });
  },
  win() {
    const steps = [523, 659, 784, 1047, 1319];
    steps.forEach((f, i) => this.tone({ freq: f, dur: 0.24, type: 'triangle', gain: 0.3, delay: i * 0.09 }));
  },
};
