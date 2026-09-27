// Difficulty measurement rig — `node tools/balance.mjs [candidatesPerTier]`.
//
// Minesweeper has no artwork to hide behind: the only difficulty a board can have is the
// reasoning the solver had to do to clear it. So the tier bands in generate.js are read
// off this table, and the rejection rate is part of the product — a tier that needs 40 000
// tries before one board survives is a spinner, not a difficulty level.
//
// Every number here comes from actually running the solver on actually generated layouts.

import { makeRng } from '../js/engine/rng.js';
import { TIERS, attempt, generate, fieldOf } from '../js/engine/generate.js';
import { solve } from '../js/engine/solver.js';
import { OPEN, makeField } from '../js/engine/field.js';

const N = Number(process.argv[2] || 3000);

const fmt = (a) => {
  const s = [...a].sort((x, y) => x - y);
  if (!s.length) return '—';
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return `${s[0].toFixed(1)} / ${q(0.05).toFixed(1)} / ${q(0.25).toFixed(1)} / ${q(0.5).toFixed(1)} / ${q(0.75).toFixed(1)} / ${q(0.95).toFixed(1)} / ${s[s.length - 1].toFixed(1)}`;
};
const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);

console.log(`candidates per tier: ${N}\n`);
console.log('tier        size   mines  accepted  ms/cand  score min/p5/p25/med/p75/p95/max         passes  3BV  subset  budget');

const tables = [];
for (const tier of TIERS) {
  const rng = makeRng(`balance|${tier.id}`);
  const scores = [];
  const passes = [];
  const bvs = [];
  let accepted = 0;
  let subset = 0;
  let budget = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) {
    const made = attempt(tier, rng);
    if (!made) continue;
    accepted++;
    scores.push(made.stats.score);
    passes.push(made.stats.passes);
    bvs.push(made.stats.threeBV);
    if (made.stats.kinds.includes('subset')) subset++;
    if (made.stats.kinds.includes('budget')) budget++;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  tables.push({ tier, scores });
  console.log(
    `${tier.label.padEnd(5)} ${(tier.w + '×' + tier.h).padEnd(9)}`.padEnd(17) +
      `${String(tier.mines).padStart(4)}` +
      `${((100 * accepted) / N).toFixed(1) + '%'}`.padStart(10) +
      `${(ms / N).toFixed(2)}`.padStart(10) +
      `  ${fmt(scores)}` +
      `${String(med(passes)).padStart(9)}` +
      `${String(med(bvs)).padStart(5)}` +
      `${((100 * subset) / Math.max(1, accepted)).toFixed(0) + '%'}`.padStart(8) +
      `${((100 * budget) / Math.max(1, accepted)).toFixed(0) + '%'}`.padStart(8)
  );
}

// Cross-check on the solver itself. If it declares a board clearable, replaying it must
// open every safe cell without ever opening a mine, and it must not name more mines than
// the board holds. A solver that lied here would ship guessable boards while the
// acceptance rate still looked healthy — which is the one failure mode this repo cannot
// afford, since "no guessing" is the entire claim.
let checked = 0;
let bad = 0;
for (const { tier, scores } of tables) {
  if (!scores.length) continue;
  const sorted = [...scores].sort((a, b) => a - b);
  const probes = [sorted[0], sorted[(sorted.length * 0.25) | 0], med(sorted), sorted[(sorted.length * 0.95) | 0], sorted[sorted.length - 1]];
  const rng = makeRng(`crosscheck|${tier.id}`);
  for (const want of probes) {
    for (let guard = 0; guard < 40000; guard++) {
      const made = attempt(tier, rng);
      if (!made) continue;
      if (Math.abs(made.stats.score - want) > 1e-9) continue;
      const field = makeField({ w: tier.w, h: tier.h, mines: Uint8Array.from(made.mines), start: made.start });
      const res = solve(field, { start: made.start });
      let openedMines = 0;
      let safeLeft = 0;
      for (let i = 0; i < field.state.length; i++) {
        if (field.state[i] === OPEN && field.mines[i]) openedMines++;
        if (field.state[i] !== OPEN && !field.mines[i]) safeLeft++;
      }
      let named = 0;
      for (const m of res.knownMine) named += m;
      const lies = openedMines > 0 || named > tier.mines || (res.noGuess && safeLeft > 0);
      checked++;
      if (lies) {
        bad++;
        console.log(`  CROSS-CHECK FAIL ${tier.id} score=${want} openedMines=${openedMines} named=${named}/${tier.mines} safeLeft=${safeLeft}`);
      }
      break;
    }
  }
}
console.log(`\nsolver cross-check: ${checked - bad}/${checked} replays clean`);

// What a player actually receives: the real generate() path, end to end, timed. This is
// the number that decides whether a tier is a difficulty level or a spinner.
console.log('\ngenerate() output — 60 boards per tier:');
for (const tier of TIERS) {
  const t0 = process.hrtime.bigint();
  const scores = [];
  let tries = 0;
  let relaxed = 0;
  let inBand = 0;
  let boards = 0;
  for (let s = 0; s < 60; s++) {
    const p = generate(tier.id, `wall-${s}`);
    if (!p) {
      console.log(`  ${tier.id} → NULL board`);
      continue;
    }
    boards++;
    tries += p.tries;
    relaxed += p.relaxed;
    scores.push(p.stats.score);
    if (p.stats.score >= tier.band[0] && p.stats.score <= tier.band[1]) inBand++;
    if (!fieldOf(p)) console.log('  FIELD FAIL');
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(
    `  ${tier.id.padEnd(10)} ${(ms / Math.max(1, boards)).toFixed(1)} ms/board  attempts ${String((tries / Math.max(1, boards)).toFixed(1)).padStart(6)}  in-band ${inBand}/${boards}  relaxed ${relaxed}/${boards}  score ${fmt(scores)}`
  );
}
