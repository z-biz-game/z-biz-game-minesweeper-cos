// Difficulty measurement rig — `node tools/balance.mjs [candidatesPerTier]`.
//
// Minesweeper has no artwork to hide behind: the only difficulty a board can have is the
// reasoning the solver had to do to clear it. So the tier bands in generate.js are read
// off this table, and the rejection rate is part of the product — a tier that needs 40 000
// tries before one board survives is a spinner, not a difficulty level.
//
// Every number here comes from actually running the solver on actually generated layouts.
//
// The exit code IS the verdict: this rig prints `CROSS-CHECK FAIL`, `NULL board`,
// `FIELD FAIL` and `in-band k/n` and used to leave 0 behind no matter what, so nothing
// downstream could ever be red on it.

import { makeRng } from '../js/engine/rng.js';
import { TIERS, attempt, generate, fieldOf } from '../js/engine/generate.js';
import { solve } from '../js/engine/solver.js';
import { OPEN, makeField } from '../js/engine/field.js';

const fails = [];
const N = Number(process.argv[2] || 3000);
// 每档重放的探针位（分数排好序后的秩）：最小、p25、中位、p95、最大。
const PROBE_RANKS = [0, 0.25, 0.5, 0.95, 1];

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
  // Keep a replayable copy of every accepted board: the cross-check below needs the
  // boards that sit at the quantiles, and re-searching for "a board with this exact
  // score" is what made this rig take 110 s and quietly check fewer probes the bigger
  // the sample got.
  const kept = [];
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
    kept.push({ score: made.stats.score, mines: made.mines, start: made.start });
    if (made.stats.kinds.includes('subset')) subset++;
    if (made.stats.kinds.includes('budget')) budget++;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (!accepted) fails.push(`${tier.id} 在 ${N} 个候选里一个盘都没入选 —— 这一档的表是空的`);
  tables.push({ tier, scores, kept });
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
//
// The probes are the boards sitting at the rank positions of the table printed above —
// the same objects, not a re-search for "some board with this score". Re-searching cost
// ~100 s of the rig's ~110 s and, worse, quietly checked 18 boards at N=3000 while
// reporting "18/18 replays clean": the bigger the sample, the less it actually replayed.
let checked = 0;
let bad = 0;
let probeSlots = 0;
const perTier = [];
for (const { tier, kept } of tables) {
  const byScore = kept.slice().sort((a, b) => a.score - b.score);
  if (!byScore.length) continue;
  const probes = [...new Set(PROBE_RANKS
    .map((p) => byScore[Math.min(byScore.length - 1, Math.floor(p * byScore.length))]))];
  probeSlots += probes.length;
  let ok = 0;
  for (const k of probes) {
    const field = makeField({ w: tier.w, h: tier.h, mines: Uint8Array.from(k.mines), start: k.start });
    const res = solve(field, { start: k.start });
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
      console.log(`  CROSS-CHECK FAIL ${tier.id} score=${k.score} openedMines=${openedMines} named=${named}/${tier.mines} safeLeft=${safeLeft}`);
    } else ok++;
  }
  perTier.push(`${tier.id} ${ok}/${probes.length}`);
}
console.log(`\nsolver cross-check: ${checked - bad}/${probeSlots} replays clean  (${perTier.join('  ')})`);
if (bad) fails.push(`solver cross-check: ${bad} 局说谎（详见上面的 CROSS-CHECK FAIL）`);
// 探针排不满就说明某档的样本太少，而「18/18 replays clean」这种句子会把它读成过关。
if (probeSlots !== TIERS.length * PROBE_RANKS.length) {
  fails.push(`solver cross-check 只排到 ${probeSlots} 个探针，应排 ${TIERS.length * PROBE_RANKS.length}`
    + `（${TIERS.length} 档 × 每档 ${PROBE_RANKS.length} 个秩）—— 有档的入选盘不足 ${PROBE_RANKS.length} 局`);
}

// What a player actually receives: the real generate() path, end to end, timed. This is
// the number that decides whether a tier is a difficulty level or a spinner.
console.log('\ngenerate() output — 60 boards per tier:');
const WALL = 60;
for (const tier of TIERS) {
  const t0 = process.hrtime.bigint();
  const scores = [];
  let tries = 0;
  let relaxed = 0;
  let inBand = 0;
  let boards = 0;
  let nulls = 0;
  let fieldFails = 0;
  for (let s = 0; s < WALL; s++) {
    const p = generate(tier.id, `wall-${s}`);
    if (!p) {
      nulls++;
      console.log(`  ${tier.id} → NULL board`);
      continue;
    }
    boards++;
    tries += p.tries;
    relaxed += p.relaxed;
    scores.push(p.stats.score);
    if (p.stats.score >= tier.band[0] && p.stats.score <= tier.band[1]) inBand++;
    if (!fieldOf(p)) {
      fieldFails++;
      console.log('  FIELD FAIL');
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (nulls) fails.push(`${tier.id} 有 ${nulls}/${WALL} 个种子返回 NULL —— 玩家点这一档会拿不到盘`);
  if (fieldFails) fails.push(`${tier.id} 有 ${fieldFails} 局的 fieldOf() 建不出来`);
  if (inBand < boards) fails.push(`${tier.id} 出货分数有 ${boards - inBand} 局落在 band [${tier.band}] 之外`);
  console.log(
    `  ${tier.id.padEnd(10)} ${(ms / Math.max(1, boards)).toFixed(1)} ms/board  attempts ${String((tries / Math.max(1, boards)).toFixed(1)).padStart(6)}  in-band ${inBand}/${boards}  relaxed ${relaxed}/${boards}  score ${fmt(scores)}`
  );
}

fails.forEach((f) => console.log(`\nFAIL ${f}`));
if (!fails.length) console.log('\nbalance: 全部结论按预期（cross-check 干净、出货全在 band 内、无 NULL）');
process.exit(fails.length ? 1 : 0);
