// Board generator. One promise carries this repo: every board a player receives can be
// finished without ever guessing where a mine is.
//
// That is measured, not hoped for. A candidate is a plain random layout; the solver in
// `solver.js` then plays it from the first click, and a layout survives only if the
// solver reaches every safe cell using local logic. Rejected candidates cost nothing but
// time, so the generator can afford to look at a few hundred.
//
// The first click is handled the way players expect: mines are placed *after* it, and the
// clicked cell plus its ring stays mine-free, so the opening move always opens a region
// instead of ending the run.

import { makeRng } from './rng.js';
import { makeField, safeStartSet, threeBV } from './field.js';
import { solve } from './solver.js';

// Sizes are the classic grid. The difficulty bands are *not* a feeling: `node tools/balance.mjs`
// runs 3 000 candidates per tier through the real solver, and each band below is that
// tier's measured interquartile range of accepted scores (3 000 candidates/tier, 2026-09-27):
//   tier      size      mines  accepted  score min / p25 / med / p75 / max      ms per candidate
//     新兵    9×9        10     82.3 %     22.3 / 32.1 / 36.5 / 45.5 / 79.1      0.03
//     老兵    12×12      22     60.4 %     36.5 / 54.4 / 64.4 / 74.1 / 113.5     0.07
//     工兵    16×16      40     54.6 %     50.8 / 77.4 / 89.0 / 100.7 / 145.6    0.14
//     排雷手  24×16      70     24.9 %     89.4 / 134.1 / 149.0 / 163.2 / 220.9  0.26
//     突击队  30×16      99      5.0 %     165.1 / 193.9 / 210.8 / 229.2 / 264.2 0.31
// Two properties the bands are chosen for, and the engine tests assert:
//   · they do not overlap — the hardest 排雷手 board is still lighter than the easiest 突击队
//     one, so a tier name means something;
//   · each holds ~50 % of its tier's candidates, so a board arrives in a few attempts
//     instead of a spinner. A band that sits above the achievable maximum is invisible: the
//     generator quietly returns its nearest miss forever, which is how "突击队" nearly ended
//     up meaning "the one that loads slowly". Re-measure after any change to grade() or the
//     solver, and trust the table over the memory.
export const TIERS = [
  { id: 'trainee', label: '新兵', w: 9, h: 9, mines: 10, band: [32, 46], blurb: '九宫格里练手感' },
  { id: 'soldier', label: '老兵', w: 12, h: 12, mines: 22, band: [54, 75], blurb: '成排推进，一次开花一大片' },
  { id: 'scout', label: '工兵', w: 16, h: 16, mines: 40, band: [77, 101], blurb: '要靠两条线索相减' },
  { id: 'sapper', label: '排雷手', w: 24, h: 16, mines: 70, band: [134, 164], blurb: '长边推理，处处开花' },
  { id: 'commando', label: '突击队', w: 30, h: 16, mines: 99, band: [194, 230], blurb: '密布的雷区，一步看三格' },
];

export const tierById = (id) => TIERS.find((t) => t.id === id) || TIERS[1];

// A random layout with `count` mines, none of them inside `banned`.
export function layMines(w, h, count, rng, banned) {
  const free = [];
  for (let i = 0; i < w * h; i++) if (!banned.has(i)) free.push(i);
  if (count > free.length) return null;
  rng.shuffle(free);
  const mines = new Uint8Array(w * h);
  for (let i = 0; i < count; i++) mines[free[i]] = 1;
  return mines;
}

// How much work a board is, in units that only the solver can see:
//   · 3BV — the clicks a perfect player needs, i.e. raw size of the job;
//   · passes — how many trips around the whole board logic has to make, since a board you
//     can only finish by circling back and forth is harder than a bigger one that runs straight through;
//   · maxSpan — the widest band of cells that must be held in mind at once;
//   · which *kinds* of deduction the board forces: plain clue arithmetic, subset
//     subtraction, or the global mine budget;
//   · density — 20 mines on 81 cells and 20 on 240 do not feel alike.
export function grade(field, res) {
  const bv = threeBV(field);
  const area = field.w * field.h;
  const density = field.minesLeft / area;
  const kinds = res.ruleKinds;
  const score =
    bv.total * 0.5 +
    res.passes * 1.2 +
    res.maxSpan * 0.8 +
    (kinds.includes('subset') ? 7 : 0) +
    (kinds.includes('budget') ? 10 : 0) +
    density * 130;
  return {
    score: Math.round(score * 10) / 10,
    threeBV: bv.total,
    regions: bv.bv,
    isolated: bv.isolated,
    passes: res.passes,
    maxSpan: res.maxSpan,
    kinds,
    density: Math.round(density * 1000) / 1000,
    stuckSafe: res.stuckSafe,
    stuckMines: res.stuck - res.stuckSafe,
  };
}

// One candidate: a layout, played by the solver, scored. Returns null when the layout
// needs a guess, which is the common case on the dense tiers. The board the player gets is
// rebuilt in `finish`, because `solve` floods through the one it probes.
// Exported so `tools/balance.mjs` measures the same rejection rate the game runs on.
export function attempt(tier, rng, mineOffset = 0) {
  const count = tier.mines + mineOffset;
  if (count < 1 || count > tier.w * tier.h - 9) return null;
  const start = rng.int(tier.w * tier.h);
  const banned = safeStartSet(tier.w, tier.h, start);
  const mines = layMines(tier.w, tier.h, count, rng, banned);
  if (!mines) return null;
  const field = makeField({ w: tier.w, h: tier.h, mines, start });
  const res = solve(field, { start });
  if (!res.noGuess) return null;
  const stats = grade(makeField({ w: tier.w, h: tier.h, mines, start }), res);
  return { mines, start, stats };
}

const inBand = (score, [lo, hi]) => score >= lo && score <= hi;

/**
 * Build the board for a tier + seed string. Deterministic: the same call returns the same
 * mines, which is what makes "daily board" and a resumed run mean the same puzzle.
 *
 * When no candidate lands inside the band, the closest one is still a legal board — every
 * candidate has already cleared the no-guess test, so this is a difficulty miss, not a
 * quality one. If *nothing* clears, the mine count is eased one at a time; `relaxed` says
 * how often, so the UI and the tests can tell a thinned board from an on-tier one.
 */
export function generate(tierId, seed, maxTries = 400) {
  const tier = tierById(tierId);
  const rng = makeRng(`${tier.id}|${seed}`);
  const mid = (tier.band[0] + tier.band[1]) / 2;
  let best = null;
  let tried = 0;
  let usedRelax = 0;
  for (let relaxed = 0; relaxed <= 4; relaxed++) {
    best = null;
    for (let i = 0; i < maxTries; i++) {
      tried++;
      const made = attempt(tier, rng, -relaxed);
      if (!made) continue;
      if (relaxed === 0 && inBand(made.stats.score, tier.band)) {
        return finish(tier, made, seed, 0, tried);
      }
      const miss = Math.abs(made.stats.score - mid);
      if (!best || miss < best.miss) best = { made, miss };
    }
    // Only a tier with *no* clearable board at all is worth thinning.
    usedRelax = relaxed;
    if (best) break;
  }
  if (!best) return null;
  return finish(tier, best.made, seed, usedRelax, tried);
}

function finish(tier, made, seed, relaxed, tries) {
  return {
    tier: tier.id,
    label: tier.label,
    w: tier.w,
    h: tier.h,
    mineCount: tier.mines - relaxed,
    start: made.start,
    mines: Uint8Array.from(made.mines),
    originSeed: seed,
    relaxed,
    tries,
    stats: made.stats,
  };
}

// The puzzle → the live board the UI mutates. Kept as the only way to get a field, so a
// resume path cannot accidentally re-derive a different mine layout.
export function fieldOf(puzzle) {
  return makeField({ w: puzzle.w, h: puzzle.h, mines: Uint8Array.from(puzzle.mines), start: puzzle.start });
}
