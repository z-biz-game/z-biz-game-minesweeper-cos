// Board model. Mines are laid down by the generator; everything a player can do —
// open, flood, chord, flag — is a function here so the UI never owns a rule.

export const HIDDEN = 0;
export const OPEN = 1;
export const FLAG = 2;
export const QUESTION = 3;

// Neighbour offsets are computed per index rather than stored: a 30×16 board has 480
// cells and most code touches each one many times, so an array of arrays would be
// allocated and walked far more often than these eight branches.
export function neighbours(w, h, i) {
  const x = i % w;
  const y = (i / w) | 0;
  const out = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      out.push(ny * w + nx);
    }
  }
  return out;
}

// The generator rebuilds a field on every rejection, and the grid itself never changes
// for a given size — so the neighbour lists are shared. A 30×16 board would otherwise
// allocate 480 arrays per attempt, thousands of times per balance run.
const ADJ_CACHE = new Map();

export function adjacency(w, h) {
  const key = `${w}x${h}`;
  let hit = ADJ_CACHE.get(key);
  if (!hit) {
    hit = new Array(w * h);
    for (let i = 0; i < hit.length; i++) hit[i] = neighbours(w, h, i);
    ADJ_CACHE.set(key, hit);
  }
  return hit;
}

// counts[i] = how many mines touch i. Cells that are themselves mines keep the count of
// their neighbours, which is what the reveal animation and the solver both need.
export function mineCounts(w, h, mines, adj = adjacency(w, h)) {
  const counts = new Uint8Array(w * h);
  for (let i = 0; i < mines.length; i++) {
    if (!mines[i]) continue;
    for (const n of adj[i]) counts[n]++;
  }
  return counts;
}

export function makeField({ w, h, mines, start }) {
  const adj = adjacency(w, h);
  const counts = mineCounts(w, h, mines, adj);
  let total = 0;
  for (const m of mines) total += m ? 1 : 0;
  return { w, h, mines, counts, adj, state: new Uint8Array(w * h), minesLeft: total, start: start ?? -1 };
}

// Classic zero-region expansion: opening a 0 opens its neighbours, which opens theirs.
// Returns the cells it *would* open, in the order a player would watch them appear.
//
// These rules are pure on purpose. The engine answers "what happens", the caller decides
// whether to spend a move on it — which is what lets undo record a whole region as one
// step, and lets the solver rehearse a board without touching the player's.
export function flood(field, start) {
  const { counts, state, mines } = field;
  if (state[start] === OPEN || mines[start]) return [];
  const seen = new Uint8Array(state.length);
  const queue = [start];
  const out = [];
  seen[start] = 1;
  if (state[start] !== OPEN) out.push(start);
  for (let head = 0; head < queue.length; head++) {
    const i = queue[head];
    if (counts[i] !== 0) continue;
    for (const n of field.adj[i]) {
      if (seen[n] || mines[n]) continue;
      seen[n] = 1;
      if (state[n] !== OPEN) out.push(n);
      queue.push(n);
    }
  }
  return out;
}

export function reveal(field, cells) {
  for (const c of cells) field.state[c] = OPEN;
  return cells;
}

export function openCell(field, i) {
  if (field.state[i] === OPEN) return { cells: [], boom: false };
  if (field.mines[i]) return { cells: [i], boom: true };
  return { cells: flood(field, i), boom: false };
}

// Chording: a number whose flags already match it says the remaining neighbours are safe,
// so one click opens them all. It only fires on an exact match — over-flagging must not
// silently open a mine.
export function chordPlan(field, i) {
  const counts = field.counts[i];
  if (field.state[i] !== OPEN) return { cells: [], refused: 'closed' };
  if (counts === 0) return { cells: [], refused: 'empty' };
  let flags = 0;
  const targets = [];
  for (const n of field.adj[i]) {
    if (field.state[n] === FLAG) flags++;
    else if (field.state[n] === HIDDEN || field.state[n] === QUESTION) targets.push(n);
  }
  if (!targets.length) return { cells: [], refused: 'done' };
  if (flags !== counts) return { cells: [], refused: flags > counts ? 'over' : 'under' };
  return { cells: targets, refused: null };
}

export function openCount(field) {
  let n = 0;
  for (const s of field.state) if (s === OPEN) n++;
  return n;
}

// Win = every non-mine cell is open. Flags are irrelevant, which is the rule players
// most often get wrong after a game that ends on "all flags placed".
export function isWin(field) {
  const safe = field.w * field.h - field.minesLeft;
  return openCount(field) >= safe;
}

export function safeCells(field) {
  let n = 0;
  for (const m of field.mines) if (!m) n++;
  return n;
}

// 3BV — beats per volume: the minimum number of clicks a perfect player needs. One for
// each empty region that must be entered by hand, plus one for every safe cell no flood can
// ever reach. The regions are measured with `flood` itself rather than a second BFS, so the
// number cannot drift from what a click actually uncovers on screen.
export function threeBV(field) {
  const { counts, mines } = field;
  const seen = new Uint8Array(field.state.length);
  let regions = 0;
  for (let i = 0; i < seen.length; i++) {
    if (seen[i] || mines[i] || counts[i] !== 0) continue;
    regions++;
    for (const c of flood(field, i)) seen[c] = 1;
  }
  let isolated = 0;
  for (let i = 0; i < seen.length; i++) if (!seen[i] && !mines[i]) isolated++;
  return { bv: regions, isolated, total: regions + isolated };
}

// Which cells a first click must not be able to hit: the click itself and its ring, so
// the opening move always uncovers a region instead of a single number.
export function safeStartSet(w, h, start) {
  const set = new Set([start]);
  for (const n of neighbours(w, h, start)) set.add(n);
  return set;
}

export function clueOf(field, i) {
  return field.counts[i];
}
