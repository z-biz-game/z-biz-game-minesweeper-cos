// Engine unit tests, run in plain Node: `node tools/engine-test.mjs`.
//
// These are the hand-checkable truths the whole game rests on. The interesting risk in this
// repo is not arithmetic but *soundness*: a solver that once called a mine "safe" would
// ship boards that break the one promise the game makes, and every downstream test would
// still be green because they all read the solver's own output. So the deductions are
// checked against the real mine layout, and the layout against values worked out by hand.

import {
  HIDDEN,
  OPEN,
  FLAG,
  QUESTION,
  neighbours,
  adjacency,
  mineCounts,
  makeField,
  flood,
  reveal,
  chordPlan,
  openCount,
  isWin,
  safeCells,
  threeBV,
  safeStartSet,
} from '../js/engine/field.js';
import { solve, nextHint } from '../js/engine/solver.js';
import { TIERS, tierById, generate, fieldOf } from '../js/engine/generate.js';
import { Game } from '../js/ui/game.js';
import { Store } from '../js/store.js';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  if (String(got) === String(want)) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}\n       got  ${got}\n       want ${want}`);
  }
};
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}\n       got  ${cond} ${detail}`);
  }
};

// A hand-built 5×5. '#' = mine. Four mines in the corners of a 5×5 leaves one big open
// region whose flood reaches every safe cell — small enough to verify by eye.
//   # . . . #
//   . . . . .
//   . . . . .
//   . . . . .
//   # . . . #
const LAYOUT = '1000100000000000000010001';
const MINES = [0, 4, 20, 24];
const board = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0) - 48);

console.log('== geometry ==');
eq('corner has 3 neighbours', neighbours(5, 5, 0).length, 3);
eq('edge has 5', neighbours(5, 5, 2).length, 5);
eq('interior has 8', neighbours(5, 5, 12).length, 8);
eq('bottom-right has 3', neighbours(5, 5, 24).length, 3);
eq('corner neighbours are the cells they look like', neighbours(5, 5, 0).join(','), '1,5,6');
eq('adjacency agrees with a hand call', adjacency(5, 5)[12].slice().sort((a, b) => a - b).join(','), neighbours(5, 5, 12).slice().sort((a, b) => a - b).join(','));
{
  const f = makeField({ w: 5, h: 5, mines: board(LAYOUT), start: 12 });
  eq('mines are where the picture says', [...f.mines].map((m, i) => (m ? i : -1)).filter((i) => i >= 0).join(','), MINES.join(','));
  eq('mines counted', f.minesLeft, 4);
  eq('safe cells', safeCells(f), 21);
  eq('a corner mine sees no other mine', f.counts[0], 0);
  eq('cell 6 touches the mine at 0', f.counts[6], 1);
  eq('cell 3 touches the mine at 4', f.counts[3], 1);
  eq('the centre is a zero', f.counts[12], 0);
}

console.log('== flood ==');
{
  const f = makeField({ w: 5, h: 5, mines: board(LAYOUT), start: 12 });
  const opened = flood(f, 12);
  eq('one zero opens the whole field here', opened.length, 21);
  eq('flood never returns a mine', opened.some((c) => f.mines[c]), false);
  eq('flood carries the numbered border with it', opened.includes(6) && opened.includes(3), true);
  eq('flood is pure: nothing is open yet', f.state[12], HIDDEN);
  reveal(f, opened);
  eq('reveal applies it', f.state[12], OPEN);
  eq('second flood from an open cell is empty', flood(f, 12).length, 0);
  eq('flood from a mine opens nothing', flood(f, 0).length, 0);
  eq('a number alone opens just itself', flood(makeField({ w: 5, h: 5, mines: board(LAYOUT), start: 6 }), 6).join(','), '6');
}

console.log('== chord plan ==');
{
  const f = makeField({ w: 5, h: 5, mines: board(LAYOUT), start: 12 });
  eq('chord on a hidden cell refuses', chordPlan(f, 6).refused, 'closed');
  f.state[22] = OPEN;
  eq('chord on a zero refuses', chordPlan(f, 22).refused, 'empty');
  // Cell 6 touches exactly one mine (index 0) and is ringed by seven still-hidden cells.
  f.state[6] = OPEN;
  eq('under-flagged refuses', chordPlan(f, 6).refused, 'under');
  f.state[0] = FLAG;
  eq('exact flags produce the remaining unknowns', chordPlan(f, 6).cells.join(','), '1,2,5,7,10,11,12');
  f.state[1] = QUESTION;
  eq('a question mark is still unknown to a chord', chordPlan(f, 6).cells.join(','), '1,2,5,7,10,11,12');
  f.state[1] = FLAG;
  eq('one flag too many refuses instead of digging', chordPlan(f, 6).refused, 'over');
  for (const n of neighbours(5, 5, 6)) if (n !== 0) f.state[n] = OPEN;
  eq('nothing left to open refuses as done', chordPlan(f, 6).refused, 'done');
}

console.log('== win condition and 3BV ==');
{
  const f = makeField({ w: 5, h: 5, mines: board(LAYOUT), start: 12 });
  for (const m of MINES) f.state[m] = FLAG;
  eq('flags alone do not win', isWin(f), false);
  const safe = [];
  for (let i = 0; i < 25; i++) if (!f.mines[i]) safe.push(i);
  reveal(f, safe.slice(0, 20));
  eq('one safe cell short is not a win', isWin(f), false);
  f.state[safe[20]] = OPEN;
  eq('every safe cell open is the win', isWin(f), true);
  eq('openCount ignores flags', openCount(f), 21);
}
{
  const blank = makeField({ w: 3, h: 3, mines: new Uint8Array(9), start: 0 });
  eq('a mine-free board is one click', threeBV(blank).total, 1);
  const corner = makeField({ w: 3, h: 3, mines: board('100000000'), start: 8 });
  eq('a corner mine is still one click', threeBV(corner).total, 1);
  // A ring of eight mines around the centre leaves no zero anywhere: every one of the 17
  // safe cells has to be clicked by hand, so 3BV is the whole safe count.
  const walled = makeField({ w: 5, h: 5, mines: board('00000011101010001110' + '00000'), start: 12 });
  const t = threeBV(walled);
  eq('no zero region means no free click', t.bv, 0);
  eq('every safe cell is isolated', t.isolated, 17);
  eq('so 3BV is 17', t.total, 17);
  // One zero in the corner, everything else numbered: one free click plus 14 by hand.
  const lonely = threeBV(makeField({ w: 5, h: 5, mines: board('00000001101010001110' + '00000'), start: 0 }));
  eq('the lone zero region counts once', lonely.bv, 1);
  eq('and covers exactly itself plus its border', lonely.isolated, 14);
  eq('the 5×5 corner layout is a single click', threeBV(makeField({ w: 5, h: 5, mines: board(LAYOUT), start: 12 })).total, 1);
}

console.log('== first-click safety ==');
for (const tier of TIERS) {
  let bad = 0;
  let notOpen = 0;
  for (let s = 0; s < 12; s++) {
    const p = generate(tier.id, `start-${s}`);
    const ring = safeStartSet(p.w, p.h, p.start);
    for (const c of ring) if (p.mines[c]) bad++;
    // The opening dig must uncover more than the cell itself, or the promise is hollow.
    const f = fieldOf(p);
    if (flood(f, p.start).length < ring.size) notOpen++;
  }
  eq(`${tier.id}: mines never touch the opening ring`, bad, 0);
  eq(`${tier.id}: the opening dig floods the whole ring`, notOpen, 0);
}

console.log('== solver soundness over generated boards ==');
// The claim under test: for every board the generator ships, the solver reaches *every*
// safe cell from the opening dig without ever stepping on a mine. Anything less and the
// board is guessable, which is the bug this whole repo exists to prevent.
for (const tier of TIERS) {
  let boards = 0;
  let openedMine = 0;
  let safeLeft = 0;
  let overNamed = 0;
  let notClaimed = 0;
  for (let s = 0; s < 25; s++) {
    const p = generate(tier.id, `audit-${s}`);
    if (!p) continue;
    boards++;
    const f = fieldOf(p);
    const res = solve(f, { start: p.start });
    if (!res.noGuess) notClaimed++;
    let named = 0;
    for (const m of res.knownMine) named += m;
    if (named > p.mineCount) overNamed++;
    for (let i = 0; i < f.state.length; i++) {
      if (f.state[i] === OPEN && f.mines[i]) openedMine++;
      if (f.state[i] !== OPEN && !f.mines[i]) safeLeft++;
    }
  }
  eq(`${tier.id}: ${boards} boards, never opened a mine`, openedMine, 0);
  eq(`${tier.id}: every safe cell reached`, safeLeft, 0);
  eq(`${tier.id}: never named more mines than exist`, overNamed, 0);
  eq(`${tier.id}: noGuess claim matches reality`, notClaimed, 0);
}

console.log('== hint soundness during a real playthrough ==');
// nextHint is the voice the game speaks to the player with. If it ever names a cell that is
// actually the opposite of what it claims, the player is blamed for trusting us.
Store.data.settings = { sound: false, autoFlag: false, question: false, reduceMotion: true };
for (const tier of TIERS) {
  let steps = 0;
  let wrongSafe = 0;
  let wrongMine = 0;
  let unwinnable = 0;
  let unflagged = 0;
  for (let s = 0; s < 8; s++) {
    const p = generate(tier.id, `hint-${s}`);
    const g = new Game(p);
    g.dig(p.start);
    let guard = 0;
    while (!g.over() && guard++ < 5000) {
      const found = nextHint(g.field);
      if (!found) break;
      steps++;
      if (found.kind === 'safe' && g.field.mines[found.cell]) wrongSafe++;
      if (found.kind === 'mine' && !g.field.mines[found.cell]) wrongMine++;
      if (found.kind === 'safe') g.dig(found.cell);
      else if (found.kind === 'unflag') {
        // Only reachable when the player flagged wrong, which this loop never does: if it
        // fires, the hint solver just contradicted itself.
        unflagged++;
        g.unflag(found.cells);
      } else g.flag(found.cell);
    }
    if (!g.finishedAt) unwinnable++;
  }
  eq(`${tier.id}: hints never called a mine safe (${steps} steps)`, wrongSafe, 0);
  eq(`${tier.id}: hints never called a safe cell a mine`, wrongMine, 0);
  eq(`${tier.id}: hints never contradicted their own flags`, unflagged, 0);
  eq(`${tier.id}: following hints wins the board`, unwinnable, 0);
}
{
  // A wrong flag must not be able to steer a hint onto a mine. The solver trusts flags as
  // knowledge, so this is the case the reconciliation exists for: the honest answer is
  // "one of your flags is wrong", and it must never be "dig here".
  Store.data.settings = { sound: false, autoFlag: false, question: false, reduceMotion: true };
  const p = generate('trainee', 'hint-wrongflag');
  const g = new Game(p);
  g.dig(p.start);
  const safeHidden = [];
  const mineHidden = [];
  for (let i = 0; i < p.mines.length; i++) {
    if (g.field.state[i] !== HIDDEN) continue;
    (p.mines[i] ? mineHidden : safeHidden).push(i);
  }
  ok('a fresh dig leaves both wrong-flag material on the board', safeHidden.length > 0 && mineHidden.length > 0, `${safeHidden.length}/${mineHidden.length}`);
  for (const c of safeHidden.slice(0, 6)) g.flag(c);
  let bad = 0;
  let told = 0;
  let blameReal = 0;
  for (let i = 0; i < 200; i++) {
    const found = nextHint(g.field);
    if (!found) break;
    if (found.kind === 'safe' && g.field.mines[found.cell]) bad++;
    if (found.kind === 'mine' && !g.field.mines[found.cell]) bad++;
    if (found.kind === 'unflag') {
      told++;
      if (found.cells.some((c) => g.field.mines[c])) blameReal++;
    }
    if (found.kind === 'safe') g.dig(found.cell);
    else if (found.kind === 'unflag') g.unflag(found.cells);
    else g.flag(found.cell);
    if (g.over()) break;
  }
  eq('a board full of wrong flags never gets a lethal hint', bad, 0);
  ok('wrong flags get named instead of a shrug', told > 0, `${told} unflag reports`);
  eq('an unflag report never blames a real mine', blameReal, 0);
}

console.log('== generator determinism and banding ==');
{
  const a = generate('scout', 'same-seed');
  const b = generate('scout', 'same-seed');
  eq('same seed → same minefield', a.mines.join(''), b.mines.join(''));
  eq('same seed → same opening cell', a.start, b.start);
  eq('same seed → same stats', a.stats.score, b.stats.score);
  const c = generate('scout', 'other-seed');
  eq('different seed → different minefield', c.mines.join('') !== a.mines.join(''), true + '');
  eq('originSeed is what the caller passed', a.originSeed, 'same-seed');
}
for (const tier of TIERS) {
  let inBand = 0;
  let nulls = 0;
  let relaxed = 0;
  let attempts = 0;
  for (let s = 0; s < 20; s++) {
    const p = generate(tier.id, `band-${s}`);
    if (!p) nulls++;
    else {
      if (p.stats.score >= tier.band[0] && p.stats.score <= tier.band[1]) inBand++;
      relaxed += p.relaxed;
      attempts += p.tries;
    }
  }
  eq(`${tier.id}: always produces a board`, nulls, 0);
  eq(`${tier.id}: 20/20 inside the advertised band`, inBand, 20);
  eq(`${tier.id}: no board needed its mine count eased`, relaxed, 0);
  // A band nobody can reach is invisible in the first two assertions: generate() answers
  // with its nearest miss forever, so the tier still ships legal boards, just not the
  // difficulty on the label — and 400 attempts of them. Attempts are seed-determined, so
  // this catches a drifted band without timing anything.
  ok(`${tier.id}: a band the generator actually reaches`, attempts / 20 < 120, (attempts / 20).toFixed(1) + ' attempts/board');
}
{
  // The tier names have to mean something: the easiest 突击队 must be harder than the hardest
  // 排雷手, or "pick a difficulty" is a lie about the shape of the board.
  let overlap = 0;
  for (let i = 1; i < TIERS.length; i++) if (TIERS[i].band[0] <= TIERS[i - 1].band[1]) overlap++;
  eq('difficulty bands do not overlap', overlap, 0);
  let sizeUp = 0;
  for (let i = 1; i < TIERS.length; i++) {
    const a = TIERS[i - 1];
    const b = TIERS[i];
    if (b.w * b.h < a.w * a.h || b.mines / (b.w * b.h) <= a.mines / (a.w * a.h)) sizeUp++;
  }
  eq('each tier is bigger and denser than the last', sizeUp, 0);
}
{
  const t = tierById('nope');
  eq('unknown tier falls back instead of throwing', t.id, TIERS[1].id);
  // A request that can never be satisfied must say so rather than spin or ship garbage.
  const impossible = generate('trainee', 'x', 1);
  ok('tiny search budget still returns a legal board or null', impossible === null || impossible.stats, String(impossible && impossible.stats.score));
}

console.log('== game rules ==');
{
  Store.data.settings = { sound: false, autoFlag: false, question: false, reduceMotion: true };
  const p = generate('trainee', 'rules-1');
  const g = new Game(p);
  eq('nothing opened at start', g.hasOpened(), false);
  eq('digging elsewhere first is refused', g.dig((p.start + 5) % 81).refused, 'first');
  eq('flagging before the first dig is refused', g.flag(0).refused, 'nodig');
  eq('a refused action is not a move', g.moves, 0);
  const r = g.dig(p.start);
  ok('the opening dig opens a region', r.cells.length > 1, r.cells.length + ' cells');
  eq('one dig is one move', g.moves, 1);
  eq('one dig is one undo entry', g.history.length, 1);
  eq('the region is in history whole', g.history[0].length, r.cells.length);
  const before = Array.from(g.state()).join('');
  eq('undo takes the whole region back', g.undo(), true);
  eq('after undo nothing is open', g.hasOpened(), false);
  eq('redo restores the same board', g.redo(), true);
  eq('redo matches the original', Array.from(g.state()).join(''), before);
  g.undo();
  g.dig(p.start);
  eq('a new action clears redo', g.redone.length, 0);

  const open = [];
  for (let i = 0; i < 81; i++) if (g.field.state[i] === OPEN) open.push(i);
  eq('flagging an open number is refused', g.flag(open[0]).refused, 'open');
  const hidden = g.field.state.findIndex((s) => s === HIDDEN);
  eq('flag places a flag', g.flag(hidden).state, FLAG);
  // Digging through your own flag is a slip of the finger, not a decision: the cell the
  // player has *claimed* is a mine must never open under them.
  const movesBefore = g.moves;
  eq('a flagged cell cannot be dug', g.dig(hidden).refused, 'flagged');
  eq('the flag is still there', g.field.state[hidden], FLAG);
  eq('a refused dig is not a move', g.moves, movesBefore);
  eq('flag again clears it (questions off)', g.flag(hidden).state, HIDDEN);
  Store.data.settings.question = true;
  g.flag(hidden);
  eq('with questions on: flag → question', g.flag(hidden).state, QUESTION);
  eq('question → hidden', g.flag(hidden).state, HIDDEN);
  Store.data.settings.question = false;

  const snapshot = Array.from(g.state());
  eq('mines left counts flags', g.minesLeft(), p.mineCount - 0);
  g.flag(hidden);
  eq('a flag is deducted from the counter', g.minesLeft(), p.mineCount - 1);
  g.undo();
  eq('undo brings the counter back', Array.from(g.state()).join(''), snapshot.join(''));
  // The refusal protects the mark, not the cell: with the flag gone the same dig works.
  eq('an unflagged cell digs again', g.dig(hidden).refused, undefined);
}
{
  // Auto-flag rides in the move that earned it: one undo must take the dig and the flags
  // it implied back together, or the stack describes a board nobody could have clicked.
  Store.data.settings.autoFlag = true;
  const p = generate('trainee', 'rules-autoflag');
  const g = new Game(p);
  g.dig(p.start);
  const before = g.history.length;
  g.tap(g.puzzle.start, 'dig');
  ok('a second action still produces one entry', g.history.length <= before + 1, g.history.length + '');
  const mine = [...p.mines].findIndex((m) => m);
  const numbered = neighbours(p.w, p.h, mine).find((n) => !p.mines[n] && g.field.state[n] === OPEN);
  if (numbered !== undefined) {
    // Force the situation: all of a number's unknown neighbours are mines.
    const ring = neighbours(p.w, p.h, numbered);
    for (const n of ring) if (!g.field.mines[n] && g.field.state[n] === HIDDEN) g.field.state[n] = OPEN;
    const entry = g.history.length;
    g.move = [];
    const added = g.autoFlag();
    g.commit();
    ok('auto-flag did something or had nothing to do', added >= 0);
    if (added) {
      eq('auto flags are one undo step with the move', g.history.length, entry + 1);
      g.undo();
      eq('one undo removed the dig and its flags together', g.history.length, entry);
    }
  }
  Store.data.settings.autoFlag = false;
}
{
  Store.data.settings.autoFlag = false;
  const p = generate('trainee', 'rules-boom');
  const g = new Game(p);
  g.dig(p.start);
  const mine = [...p.mines].findIndex((m) => m);
  const res = g.dig(mine);
  eq('digging a mine blows the run', res.boom, true);
  eq('the board is over', g.over(), true);
  eq('a blown run cannot be undone', g.undo(), false);
  eq('time stops at the boom', g.elapsed() >= 0 && !!g.deadAt, true);
  eq('no further digging', g.dig(p.start === mine ? (mine + 1) % 81 : p.start).refused, 'finished');
  eq('no further flagging', g.flag(0).refused, 'finished');
  eq('no further chording', g.chordAt(p.start).refused, 'finished');
  const missed = g.missedMines().length;
  ok('the loss report names the mines left unflagged', missed > 0, missed + ' mines');
  // 'over' meant "run finished" *and* "too many flags" — the second case shadowed the first,
  // so a dead board answered a click with chord advice. The two states must have two names.
  ok('a dead run and an over-flagged clue are different refusals', g.dig(p.start).refused !== 'over', g.dig(p.start).refused);
}
{
  // Chording through the game layer, and the fatal case: flags complete but wrong.
  const p = generate('soldier', 'rules-chord');
  const g = new Game(p);
  g.dig(p.start);
  const target = [...g.field.state.keys()].find(
    (i) => g.field.state[i] === OPEN && p.counts?.[i] !== 0 && g.field.counts[i] > 0
  );
  if (target !== undefined) {
    const ring = neighbours(p.w, p.h, target);
    const mines = ring.filter((n) => p.mines[n]);
    for (const m of mines) g.field.state[m] = FLAG;
    const wrong = ring.find((n) => !p.mines[n] && g.field.state[n] === HIDDEN);
    if (mines.length < g.field.counts[target] && wrong !== undefined) {
      g.field.state[wrong] = FLAG;
      eq('a full-but-wrong flag set booms on chord', g.chordAt(target).boom, true);
    } else {
      const r = g.chordAt(target);
      ok('an exact-match chord opens the rest', !r.refused, JSON.stringify(r.refused));
      eq('a chord is one move', g.moves, 2);
    }
  }
}

console.log('== persistence shape ==');
{
  const p = generate('trainee', 'store-1');
  const g = new Game(p);
  g.dig(p.start);
  g.flag(g.field.state.findIndex((s, i) => s === HIDDEN && !p.mines[i]));
  Store.data.resume = null;
  Store.saveResume(p, g.state(), 1234, { moves: g.moves, hints: g.hintsUsed });
  const raw = JSON.stringify(Store.data.resume);
  ok('a save stays small on a 9×9', raw.length < 400, raw.length + ' bytes');
  const r = Store.resume();
  eq('resume keeps the origin seed', r.seed, 'store-1');
  eq('resume ink decodes to the board length', r.board.length, 81);
  eq('resume ink is the board it saved', Array.from(r.board).join(''), Array.from(g.state()).join(''));
  eq('the mine layout is not stored at all', raw.includes('"mines"'), false);
  // A best time is decided by 求助 first, so a resume that dropped the count would hand a
  // clean record to anyone willing to close the tab mid-run and come back.
  eq('resume carries the move count', r.moves, g.moves);
  eq('resume carries the hint count', r.hints, g.hintsUsed);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
