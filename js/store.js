// Persistence. Everything lives under one key so a reset is one line, and a run in
// progress is stored as (seed, tier, run-length cell states) rather than a copy of the
// mine layout — the generator is deterministic, so the mines never have to travel through
// storage, and a save stays small even on 30×16.

const KEY = 'minesweeper.save.v1';

const defaults = () => ({
  settings: { sound: true, autoFlag: true, question: false, reduceMotion: false },
  best: {},
  daily: { lastKey: null, streak: 0, solved: [] },
  resume: null,
  totals: { solved: 0, hints: 0, ms: 0 },
});

// Cell states are 0 hidden / 1 open / 2 flag / 3 question, and a board is mostly one long
// run of 0s early on — run-length coding keeps a 480-cell board under a hundred bytes.
function rleEncode(board) {
  const out = [];
  let run = board[0] || 0;
  let n = 1;
  for (let i = 1; i < board.length; i++) {
    if (board[i] === run && n < 255) n++;
    else {
      out.push(run, n);
      run = board[i];
      n = 1;
    }
  }
  out.push(run, n);
  return out;
}

function rleDecode(pairs, len) {
  const b = new Uint8Array(len);
  let i = 0;
  for (let p = 0; p < pairs.length; p += 2) {
    const v = pairs[p];
    const n = pairs[p + 1];
    // 长度不合法的游程直接跳过而不是写进去：一段 1e6 的 run 会把整盘格子刷成同一个状态。
    if (!Number.isInteger(n) || n <= 0 || !Number.isInteger(v) || v < 0 || v > 3) continue;
    for (let k = 0; k < n && i < len; k++) b[i++] = v;
  }
  return b;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// 形状对不等于日期存在：'2026-13-45' 过正则，过不了 Date。它一旦被当成真日期喂给
// markDaily，new Date(...) 得 Invalid Date，差值 NaN，连续天数就在玩家没做错任何事时归 1。
function validDay(k) {
  if (typeof k !== 'string' || !DAY_RE.test(k)) return false;
  const d = new Date(k + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return false;
  const [y, m, day] = k.split('-').map(Number);
  return d.getFullYear() === y && d.getMonth() + 1 === m && d.getDate() === day;
}
const isNum = (v, min = -Infinity) => typeof v === 'number' && Number.isFinite(v) && v >= min;
const isInt = (v, min = -Infinity, max = Infinity) => Number.isInteger(v) && v >= min && v <= max;
// 上限是给"手工编辑过的存档"留的：30×16=480 是现有阶梯的最大盘，
// 但没有一个数会阻止 1e9 进 Uint8Array —— 那是一颗 RangeError 炸弹，在启动路径上。
const MAX_CELLS = 4096;

// 第一段：逐条验记录。一条坏记录只丢它自己，其余照常留下。
// 整块存档因为一个小数点、一个被截断的写盘就清零，是"读档丢进度"里最难被察觉的一种。
function validResume(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
  if (typeof r.seed !== 'string' || !r.seed) return false;
  if (typeof r.tier !== 'string' || !r.tier) return false;
  if (!isNum(r.elapsedMs, 0) || r.elapsedMs > 24 * 3600 * 1000) return false;
  if (!isInt(r.cells, 1, MAX_CELLS)) return false;
  if (!isInt(r.moves, 0) || !isInt(r.hints, 0)) return false;
  if (!Array.isArray(r.ink) || r.ink.length % 2 !== 0 || r.ink.length > r.cells * 2 + 2) return false;
  for (let p = 0; p < r.ink.length; p += 2) {
    if (!isInt(r.ink[p], 0, 3) || !isInt(r.ink[p + 1], 1, 255)) return false;
  }
  return true;
}

function sanitize(parsed) {
  const base = defaults();
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base;
  const out = { ...base, best: {}, daily: { ...base.daily, solved: [] }, totals: { ...base.totals } };

  const st = parsed.settings;
  if (st && typeof st === 'object') {
    // 只认布尔真值：一个字符串 "false" 在 if 里是真，静音会变成"看起来静音了但还在响"。
    for (const k of Object.keys(base.settings)) if (typeof st[k] === 'boolean') out.settings[k] = st[k];
  }

  const t = parsed.totals;
  if (t && typeof t === 'object') {
    // 上限挡的是"科学计数法灾难"：1e99 是有限数，但它会被显示成 1e+99 并永久占着成绩位。
    for (const k of Object.keys(base.totals)) if (isNum(t[k], 0) && t[k] <= 1e12) out.totals[k] = Math.floor(t[k]);
  }

  const b = parsed.best;
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    for (const [tier, r] of Object.entries(b)) {
      if (!r || typeof r !== 'object') continue;                     // 坏纪录：只丢这一级
      if (!isNum(r.ms, 0) || !isInt(r.hints, 0) || !isInt(r.moves, 0) || !isInt(r.size, 1)) continue;
      out.best[tier] = { ms: r.ms, hints: r.hints, moves: r.moves, size: r.size, at: isNum(r.at, 0) ? r.at : 0 };
    }
  }

  const d = parsed.daily;
  if (d && typeof d === 'object') {
    if (isInt(d.streak, 0)) out.daily.streak = d.streak;
    if (validDay(d.lastKey)) out.daily.lastKey = d.lastKey;
    if (Array.isArray(d.solved)) out.daily.solved = d.solved.filter(validDay).slice(-90);
  }

  out.resume = validResume(parsed.resume) ? parsed.resume : null;    // 解码留给第二段
  return out;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    return sanitize(JSON.parse(raw));
  } catch {
    return defaults();
  }
}

export const Store = {
  data: load(),

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* private mode / quota — the game is still playable, just forgetful */
    }
  },

  setting(name) {
    return this.data.settings[name];
  },
  setSetting(name, value) {
    this.data.settings[name] = value;
    this.save();
  },

  best(tier) {
    return this.data.best[tier] || null;
  },
  // Best time is decided by *least help taken* first: a record must mean "I did this
  // myself", and a fast run built on six hints is not that.
  recordBest(tier, { ms, hints, moves, size }) {
    const cur = this.data.best[tier];
    const better =
      !cur ||
      hints < cur.hints ||
      (hints === cur.hints && (moves < cur.moves || (moves === cur.moves && ms < cur.ms)));
    if (better) this.data.best[tier] = { ms, hints, moves, size, at: Date.now() };
    this.save();
    return better;
  },

  recordSolve(ms, hints) {
    const t = this.data.totals;
    t.solved++;
    t.hints += hints;
    t.ms += ms;
    this.save();
  },

  // Daily streak counts calendar days, so solving twice today must not extend it.
  markDaily(key) {
    const d = this.data.daily;
    if (d.solved.includes(key)) return { streak: d.streak, isNew: false };
    const prev = new Date(d.lastKey + 'T12:00:00');
    const today = new Date(key + 'T12:00:00');
    const gapDays = Math.round((today - prev) / 86400000);
    d.streak = gapDays === 1 ? d.streak + 1 : 1;
    d.lastKey = key;
    d.solved = [...d.solved, key].slice(-90);
    this.save();
    return { streak: d.streak, isNew: true };
  },

  dailySolved(key) {
    return this.data.daily.solved.includes(key);
  },

  saveResume(puzzle, state, elapsedMs, run) {
    this.data.resume = {
      // The generator derives an internal seed from what it is handed, so a resume has to
      // store the *origin* seed or the rebuilt minefield would not be the same one.
      seed: puzzle.originSeed || puzzle.seed,
      tier: puzzle.tier,
      elapsedMs,
      cells: puzzle.w * puzzle.h,
      ink: rleEncode(state),
      // The cost of the run travels with the board. Without it a player could take six
      // hints, close the tab, come back, and finish with a clean 求助 0 record — the score
      // that decides the best time is counted from actions, and actions are not saved.
      moves: run.moves,
      hints: run.hints,
      at: Date.now(),
    };
    this.save();
  },

  // 第二段：到这里记录已经过了形状检查，展开仍然包在 try 里 ——
  // 存档坏掉只该丢掉"这一局续不上"，不该把设置、纪录、连续天数一起带走。
  resume() {
    const r = this.data.resume;
    if (!r) return null;
    try {
      const board = rleDecode(r.ink, r.cells);
      if (board.length !== r.cells) return null;
      return { ...r, board };
    } catch {
      return null;
    }
  },

  clearResume() {
    this.data.resume = null;
    this.save();
  },

  reset() {
    this.data = defaults();
    this.save();
  },
};
