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
    for (let k = 0; k < n && i < len; k++) b[i++] = v;
  }
  return b;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    const parsed = JSON.parse(raw);
    const base = defaults();
    return {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}) },
      daily: { ...base.daily, ...(parsed.daily || {}) },
      totals: { ...base.totals, ...(parsed.totals || {}) },
    };
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

  resume() {
    const r = this.data.resume;
    if (!r) return null;
    return { ...r, board: rleDecode(r.ink, r.cells) };
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
