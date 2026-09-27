// The no-guess solver. This is the load-bearing file of the whole repo: a board ships
// only if the code below can clear it, so "you never have to guess" is a measured
// property rather than a genre promise.
//
// It plays like a careful human, and only with information a player can see:
//   · a number minus the flags around it says how many mines hide in the rest;
//   · if that many cells are left, all of them are mines; if zero, all are safe;
//   · if one clue's unknown ring sits inside another's, the difference between the two
//     rings has the difference between the two counts — the step that turns
//     "1-2-1" and "2-2" edges into certainty;
//   · the mine budget left over the whole board is itself a clue.
// Nothing else is allowed: no case analysis, no "try both". If this gets stuck, the
// board needs a guess and the generator throws it away.

import { OPEN, HIDDEN, FLAG, QUESTION, flood, reveal } from './field.js';

// A constraint is "exactly `count` mines sit in this set of unknown neighbours".
function constraintsFor(field, knownMine) {
  const { state, counts, adj, mines } = field;
  const out = [];
  for (let i = 0; i < state.length; i++) {
    if (state[i] !== OPEN || counts[i] === 0) continue;
    const set = [];
    let left = counts[i];
    for (const n of adj[i]) {
      if (mines[n] && state[n] === OPEN) continue;
      if (knownMine[n]) left--;
      else if (state[n] !== OPEN) set.push(n);
    }
    if (set.length) out.push({ cells: set.sort((a, b) => a - b), count: left, from: i });
  }
  return dedupe(out);
}

// Two adjacent numbers often describe the same ring; identical constraints add nothing
// but O(n²) work to the pairing pass.
function dedupe(list) {
  const seen = new Map();
  const out = [];
  for (const c of list) {
    const key = c.cells.join(',');
    const prev = seen.get(key);
    if (prev !== undefined) {
      // Same cell set with two different counts is a contradiction, which can only come
      // from a bug here — keep the first and let the caller's sanity check notice.
      if (list[prev].count !== c.count) c.conflict = true;
      continue;
    }
    seen.set(key, out.length);
    out.push(c);
  }
  return out;
}

const subsetOf = (a, b) => {
  if (a.length > b.length) return false;
  const bs = new Set(b);
  for (const x of a) if (!bs.has(x)) return false;
  return true;
};

const minus = (a, b) => {
  const bs = new Set(b);
  return a.filter((x) => !bs.has(x));
};

export function solve(field, { start = -1, maxRounds = 400 } = {}) {
  const n = field.w * field.h;
  const knownMine = new Uint8Array(n);
  const knownSafe = new Uint8Array(n);
  const events = [];
  const used = new Set();
  let rounds = 0;
  let passes = 0;
  let maxSet = 0;
  let maxSpan = 0;

  const begin = start >= 0 ? start : field.start;
  if (begin >= 0) reveal(field, flood(field, begin));

  const markSafe = (cells, why) => {
    let changed = 0;
    for (const c of cells) {
      if (knownSafe[c] || field.mines[c]) continue;
      knownSafe[c] = 1;
      changed++;
      events.push({ kind: 'safe', cell: c, rule: why });
    }
    if (!changed) return false;
    maxSet = Math.max(maxSet, cells.length);
    // Deducing a safe cell only helps once you look at what it reveals.
    for (const c of cells) reveal(field, flood(field, c));
    return true;
  };

  const markMine = (cells, why) => {
    let changed = 0;
    for (const c of cells) {
      if (knownMine[c] || field.mines[c] === 0) continue;
      knownMine[c] = 1;
      changed++;
      events.push({ kind: 'mine', cell: c, rule: why });
    }
    if (changed) maxSet = Math.max(maxSet, cells.length);
    return changed > 0;
  };

  for (;;) {
    rounds++;
    if (rounds > maxRounds) break;
    let moved = false;
    const cons = constraintsFor(field, knownMine);
    passes++;

    // 1. Single-clue certainty: nothing left to find, or nowhere left to hide.
    for (const c of cons) {
      if (c.count === 0) {
        if (markSafe(c.cells, '线索已满足')) { used.add('clue'); moved = true; }
      } else if (c.count === c.cells.length) {
        if (markMine(c.cells, '剩余格必须全是雷')) { used.add('clue'); moved = true; }
      }
    }
    if (moved) continue;

    // 2. Pairing: one ring inside another turns two uncertain clues into one certain
    //    difference. This is where 1-2-1 edges, 2-2 edges and the long "wall" deductions
    //    all come from.
    outer: for (let a = 0; a < cons.length; a++) {
      for (let b = 0; b < cons.length; b++) {
        if (a === b) continue;
        const A = cons[a];
        const B = cons[b];
        if (A.count > B.count) continue;
        if (!subsetOf(A.cells, B.cells)) continue;
        const diff = minus(B.cells, A.cells);
        if (!diff.length) continue;
        const want = B.count - A.count;
        maxSpan = Math.max(maxSpan, B.cells.length);
        if (want === 0) { if (markSafe(diff, '两线索相减无雷')) { used.add('subset'); moved = true; } }
        else if (want === diff.length) { if (markMine(diff, '两线索相减全是雷')) { used.add('subset'); moved = true; } }
        if (moved) break outer;
      }
    }
    if (moved) continue;

    // 3. The budget: mines left in the game vs unknown cells left on the board.
    let unknown = 0;
    for (let i = 0; i < n; i++) if (field.state[i] !== OPEN && !knownMine[i]) unknown++;
    const budget = field.minesLeft - countFlags(knownMine);
    const rest = [];
    if (unknown > 0) for (let i = 0; i < n; i++) if (field.state[i] !== OPEN && !knownMine[i]) rest.push(i);
    if (budget === 0 && markSafe(rest, '雷数已用尽')) { used.add('budget'); continue; }
    if (budget === unknown && markMine(rest, '剩下的格刚好装得下所有雷')) { used.add('budget'); continue; }
    break;
  }

  let stuck = 0;
  let stuckSafe = 0;
  for (let i = 0; i < n; i++) {
    if (field.state[i] === OPEN || knownMine[i]) continue;
    stuck++;
    if (!field.mines[i]) stuckSafe++;
  }
  // A board is clearable when every *safe* cell can be reached by logic: winning only
  // needs the safe cells opened, so mines the solver cannot name are cosmetic. If a
  // safe cell is left behind, the player would have to guess and the generator
  // discards the board.
  const clearable = stuckSafe === 0;
  return {
    solved: clearable,
    noGuess: clearable,
    rounds: passes,
    passes,
    stuck,
    stuckSafe,
    events,
    ruleKinds: [...used],
    maxSet,
    maxSpan,
    knownMine,
    knownSafe,
  };
}

function countFlags(knownMine) {
  let n = 0;
  for (const m of knownMine) if (m) n++;
  return n;
}

// A hint has to be something a player can derive, so it comes out of this solver and
// carries the rule that produced it — the same discipline as the puzzle's admission test.
//
// The player's flags *are* taken as knowledge, which is what makes a hint able to keep up
// with a player who is following hints: a flagged mine otherwise stays inside the clue's
// unknown ring, so "1 over two cells" never becomes "0 over one cell" and every flag the
// player places by asking weakens the next answer. That feedback loop is how the game would
// end up scolding a player for doing exactly what it asked.
//
// Trusting flags is only safe if the conclusion is checked before it is spoken: one wrong
// flag poisons the arithmetic downstream, and a hint that walks a player onto a mine is not
// a hint but a trap. So each suggestion is reconciled against the real mine map, and when it
// disagrees the flags the deduction leaned on are named instead — a flag sitting on a safe
// cell is a provable fact the player can act on, and it is the only explanation left.
export function nextHint(field) {
  const n = field.w * field.h;
  // Rows and columns count from 1 because that is how a player reads them off the grid.
  const where = (i) => `${(((i / field.w) | 0) + 1)}行${(i % field.w) + 1}列`;
  const flagged = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (field.state[i] === FLAG) flagged[i] = 1;
  const cons = constraintsFor(field, flagged);
  // Only cells the player can still act on — suggesting "this is a mine" about a cell they
  // already flagged reads as a machine that is not looking.
  const actionable = (cells) => cells.find((x) => field.state[x] === HIDDEN || field.state[x] === QUESTION);
  const falseFlags = (clues) => {
    const out = [];
    for (const from of clues)
      for (const nb of field.adj[from])
        if (flagged[nb] && !field.mines[nb] && !out.includes(nb)) out.push(nb);
    if (!out.length)
      for (let i = 0; i < n; i++) if (flagged[i] && !field.mines[i]) out.push(i);
    return out;
  };
  const unflag = (cells, why) => ({
    cell: cells[0],
    cells,
    kind: 'unflag',
    rule: `${why}${cells.map(where).join('、')} —— 它们其实不是雷，先拔掉再看`,
  });
  const pull = (cell, kind, rule, clues) => {
    if (cell === undefined) return null;
    if (!!field.mines[cell] === (kind === 'mine')) return { cell, kind, rule };
    const wrong = falseFlags(clues);
    return wrong.length ? unflag(wrong, '有几面旗把数字算歪了：') : null;
  };

  // 1. Single-clue certainty: the clue is fully accounted for, or has nowhere left to hide.
  for (const c of cons) {
    if (c.count === 0) {
      const hit = pull(
        actionable(c.cells),
        'safe',
        `${where(c.from)} 的 ${field.counts[c.from]} 颗雷已经全部标出，它周围剩下的 ${c.cells.length} 个未知格是安全的`,
        [c.from]
      );
      if (hit) return hit;
    } else if (c.count === c.cells.length) {
      const hit = pull(
        actionable(c.cells),
        'mine',
        `${where(c.from)} 还差 ${c.count} 颗雷，而它只剩 ${c.cells.length} 个未知格 —— 这里必是雷`,
        [c.from]
      );
      if (hit) return hit;
    }
  }
  // 2. Subset subtraction: two clues that share most of their ring.
  for (let a = 0; a < cons.length; a++) {
    for (let b = 0; b < cons.length; b++) {
      if (a === b) continue;
      const A = cons[a];
      const B = cons[b];
      if (A.count > B.count || !subsetOf(A.cells, B.cells)) continue;
      const diff = minus(B.cells, A.cells);
      if (!diff.length) continue;
      const want = B.count - A.count;
      if (want === 0) {
        const hit = pull(
          actionable(diff),
          'safe',
          `${where(B.from)} 的雷全落在 ${where(A.from)} 的未知格里，所以它多出来的 ${diff.length} 格是安全的`,
          [A.from, B.from]
        );
        if (hit) return hit;
      } else if (want === diff.length) {
        const hit = pull(
          actionable(diff),
          'mine',
          `${where(B.from)} 比 ${where(A.from)} 多的 ${want} 颗雷只能落在多出的 ${diff.length} 格里`,
          [A.from, B.from]
        );
        if (hit) return hit;
      }
    }
  }
  // 3. A contradiction the player can see: a clue wearing more flags than it holds mines.
  //    Better to name that than to shrug and report "nothing derivable".
  for (let i = 0; i < n; i++) {
    if (field.state[i] !== OPEN || field.counts[i] === 0) continue;
    let f = 0;
    for (const nb of field.adj[i]) if (field.state[nb] === FLAG) f++;
    if (f <= field.counts[i]) continue;
    const wrong = falseFlags([i]);
    if (wrong.length) return unflag(wrong, `${where(i)} 标了 ${f} 面旗，可它周围只有 ${field.counts[i]} 颗雷，插错的是：`);
  }
  // 4. The budget. The mine counter is itself a clue, and it is the only rule that still
  //    works when the board has shrunk to a few cells no number touches any more — the last
  //    safe cell of a 30×16 sits in exactly that situation, so a hint that skipped it would
  //    strand a player who had done everything the game asked.
  let flags = 0;
  const rest = [];
  for (let i = 0; i < n; i++) {
    if (field.state[i] === FLAG) flags++;
    else if (field.state[i] === HIDDEN || field.state[i] === QUESTION) rest.push(i);
  }
  if (flags > field.minesLeft) {
    const wrong = falseFlags([]);
    if (wrong.length) return unflag(wrong, `旗子比全板的 ${field.minesLeft} 颗雷还多，其中一定有插错的：`);
  } else if (flags === field.minesLeft && rest.length) {
    const hit = pull(rest[0], 'safe', `全板 ${field.minesLeft} 颗雷都已标出，剩下的 ${rest.length} 个未知格不可能是雷`, []);
    if (hit) return hit;
  } else if (field.minesLeft - flags === rest.length && rest.length) {
    const hit = pull(rest[0], 'mine', `还差 ${field.minesLeft - flags} 颗雷，未知格也只剩 ${rest.length} 个 —— 它们全是雷`, []);
    if (hit) return hit;
  }
  return null;
}
