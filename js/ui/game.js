// Game rules and state. Deliberately free of DOM and canvas: the win condition, the undo
// grouping and the mine accounting are all decisions the headless verifier makes exactly
// the same way a player's browser does.
//
// The engine functions are pure, so this file is the only place that writes cell states —
// which is what lets one click that opened nineteen cells undo as one step.

import {
  HIDDEN,
  OPEN,
  FLAG,
  QUESTION,
  flood,
  chordPlan,
  isWin,
  openCount,
  safeCells,
} from '../engine/field.js';
import { nextHint } from '../engine/solver.js';
import { fieldOf } from '../engine/generate.js';
import { Store } from '../store.js';

export class Game {
  constructor(puzzle, savedState) {
    this.puzzle = puzzle;
    this.field = fieldOf(puzzle);
    if (savedState && savedState.length === this.field.state.length) this.field.state.set(savedState);
    this.safe = safeCells(this.field);
    this.history = [];
    this.redone = [];
    this.move = null;
    this.moves = 0;
    this.hintsUsed = 0;
    this.startedAt = 0;
    this.pausedAt = 0;
    this.pausedTotal = 0;
    this.finishedAt = 0;
    this.deadAt = 0;
    this.view = { hints: new Set(), boom: -1, cursor: null, reveal: false };
    this.listeners = new Set();
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // Semantic events, so feedback keys off "a region just opened" rather than "a number
  // changed" — the difference between rhythm and noise.
  emit(event) {
    for (const fn of this.listeners) fn(event, this);
  }

  start() {
    if (!this.startedAt) this.startedAt = performance.now();
  }

  pause() {
    if (this.pausedAt || this.over()) return;
    this.pausedAt = performance.now();
  }

  resume() {
    if (!this.pausedAt) return;
    this.pausedTotal += performance.now() - this.pausedAt;
    this.pausedAt = 0;
  }

  elapsed(now = performance.now()) {
    if (!this.startedAt) return 0;
    return Math.max(0, (this.finishedAt || this.deadAt || now) - this.startedAt - this.pausedTotal);
  }

  over() {
    return !!(this.finishedAt || this.deadAt);
  }

  progress() {
    const opened = openCount(this.field);
    return { opened, safe: this.safe, ratio: this.safe ? opened / this.safe : 0 };
  }

  flags() {
    let n = 0;
    for (const s of this.field.state) if (s === FLAG) n++;
    return n;
  }

  minesLeft() {
    return this.puzzle.mineCount - this.flags();
  }

  hasOpened() {
    for (const s of this.field.state) if (s === OPEN) return true;
    return false;
  }

  // ---- history ---------------------------------------------------------------
  // One action is one undo step, no matter how many cells the flood opened: reverting half
  // a region would leave a board no sequence of clicks could ever have produced.
  write(cell, to) {
    if (this.field.state[cell] === to) return false;
    if (!this.move) return false;
    const from = this.field.state[cell];
    this.field.state[cell] = to;
    this.move.push({ cell, from, to });
    return true;
  }

  // The entry goes into history first, then stays open while consequences run, so the
  // flags autoFlag() adds append into that same array: one undo takes the dig and its
  // consequences back together, and a win is recorded with the move that caused it counted.
  commit() {
    const entry = this.move;
    if (!entry) return;
    this.move = null;
    if (entry.length) {
      this.history.push(entry);
      this.redone.length = 0;
      this.moves++;
      this.move = entry;
    }
    this.afterChange();
    this.move = null;
    if (entry.length) this.emit({ type: 'commit' });
  }

  // ---- actions ---------------------------------------------------------------
  // The opening move is pinned to the cell the seed chose, because that is the cell whose
  // ring the generator kept mine-free *and* the cell the solver proved the board from.
  // Refusing any other first dig is what lets "第一次挖一定安全" stay a fact instead of a
  // hope — the alternative is re-laying the board mid-run, which would break the daily.
  dig(cell) {
    if (this.over()) return { refused: 'finished' };
    if (!this.hasOpened() && cell !== this.puzzle.start) {
      this.emit({ type: 'refuse', cell, reason: 'first' });
      return { refused: 'first' };
    }
    // A flag is a claim the player already made, so digging through it is never information
    // — it is a slip of the finger that can end the run. Question marks stay diggable: they
    // are a note to look again, not an answer.
    if (this.field.state[cell] === FLAG) {
      this.emit({ type: 'refuse', cell, reason: 'flagged' });
      return { refused: 'flagged' };
    }
    this.start();
    const owns = !this.move;
    if (owns) this.move = [];
    const res = this.field.mines[cell] ? { cells: [cell], boom: true } : { cells: flood(this.field, cell), boom: false };
    if (res.boom) {
      this.move = null;
      this.field.state[cell] = OPEN;
      this.view.boom = cell;
      this.deadAt = performance.now();
      this.view.reveal = true;
      this.emit({ type: 'boom', cell });
      return { boom: true, cells: [cell] };
    }
    let changed = 0;
    for (const c of res.cells) if (this.write(c, OPEN)) changed++;
    if (owns) this.commit();
    if (changed) this.emit({ type: res.cells.length > 1 ? 'flood' : 'open', cell, cells: res.cells });
    return { cells: res.cells, opened: changed };
  }

  // Flag cycling. Question marks are opt-in: they are a note-to-self, and players who never
  // use them should not have to pass through the state twice to clear a flag.
  flag(cell) {
    if (this.over()) return { refused: 'finished' };
    // Before the first dig there is no information at all, so a flag would be a guess —
    // and guessing is the one thing this game promises not to ask for.
    if (!this.hasOpened()) {
      this.emit({ type: 'refuse', cell, reason: 'nodig' });
      return { refused: 'nodig' };
    }
    const cur = this.field.state[cell];
    if (cur === OPEN) {
      this.emit({ type: 'refuse', cell, reason: 'open' });
      return { refused: 'open' };
    }
    this.start();
    const owns = !this.move;
    if (owns) this.move = [];
    const next =
      cur === HIDDEN ? FLAG : cur === FLAG ? (Store.setting('question') ? QUESTION : HIDDEN) : HIDDEN;
    const changed = this.write(cell, next);
    if (owns) this.commit();
    if (changed) this.emit({ type: next === FLAG ? 'flag' : next === QUESTION ? 'question' : 'unflag', cell });
    return { state: next };
  }

  // Chording lives on the number itself: tapping an opened clue is how a player says "these
  // flags are my answer". An exact match is required, so an over-flagged clue refuses
  // instead of quietly opening a mine — the mistake stays the player's, and visible.
  chordAt(cell) {
    if (this.over()) return { refused: 'finished' };
    const plan = chordPlan(this.field, cell);
    if (plan.refused) {
      this.emit({ type: 'refuse', cell, reason: plan.refused });
      return { refused: plan.refused };
    }
    this.start();
    const owns = !this.move;
    if (owns) this.move = [];
    const targets = [];
    for (const c of plan.cells) if (!this.field.mines[c]) targets.push(c);
    const mine = plan.cells.find((c) => this.field.mines[c]);
    if (mine !== undefined) {
      this.move = null;
      for (const c of targets) this.field.state[c] = OPEN;
      this.field.state[mine] = OPEN;
      this.view.boom = mine;
      this.deadAt = performance.now();
      this.view.reveal = true;
      this.emit({ type: 'boom', cell: mine, via: 'chord' });
      return { boom: true, cells: [mine] };
    }
    let changed = 0;
    for (const c of targets) if (this.write(c, OPEN)) changed++;
    if (owns) this.commit();
    if (changed) this.emit({ type: 'chord', cell, cells: targets });
    return { cells: targets, opened: changed };
  }

  // A tap is a flag in 插旗 mode, a chord when it lands on an open number, and a dig
  // otherwise. Keeping that decision here means the mouse, touch and keyboard paths cannot
  // drift apart.
  tap(cell, mode) {
    if (mode === 'flag') return this.flag(cell);
    if (this.field.state[cell] === OPEN) return this.chordAt(cell);
    return this.dig(cell);
  }

  // Sound, local consequence of a clue that is fully accounted for: when a number's
  // remaining unknown neighbours exactly equal what it still needs, those cells cannot be
  // anything but mines. Toggleable, because some players want to place those flags by hand
  // — and when it is off they really are left to the player.
  autoFlag() {
    if (!Store.setting('autoFlag')) return 0;
    const { state, counts, adj } = this.field;
    const added = [];
    for (let i = 0; i < state.length; i++) {
      if (state[i] !== OPEN || counts[i] === 0) continue;
      let flags = 0;
      const unknown = [];
      for (const n of adj[i]) {
        if (state[n] === FLAG) flags++;
        else if (state[n] === HIDDEN || state[n] === QUESTION) unknown.push(n);
      }
      if (!unknown.length || flags + unknown.length !== counts[i]) continue;
      for (const c of unknown) if (this.write(c, FLAG)) added.push(c);
    }
    if (added.length) this.emit({ type: 'autoFlag', cells: added });
    return added.length;
  }

  // Take back flags the board disproved. This is the only hint that removes something: the
  // player's own mark is the error, and leaving it up would poison every later deduction —
  // including the next hint, which would blame a different neighbour for the same mistake.
  unflag(cells) {
    if (this.over()) return { refused: 'finished' };
    const owns = !this.move;
    if (owns) this.move = [];
    let removed = 0;
    for (const c of cells) if (this.field.state[c] === FLAG && this.write(c, HIDDEN)) removed++;
    if (owns) this.commit();
    if (removed) this.emit({ type: 'unflag', cells, auto: true });
    return { removed };
  }

  afterChange() {
    if (this.move) this.autoFlag();
    if (!this.deadAt && !this.finishedAt && isWin(this.field)) {
      this.finishedAt = performance.now();
      // Revealing the field on a win is not a spoiler: the player has already earned it by
      // opening every safe cell, and seeing where the mines were is the payoff.
      this.view.reveal = true;
      this.emit({ type: 'win' });
    }
  }

  undo() {
    if (this.deadAt) return false;
    const entry = this.history.pop();
    if (!entry) return false;
    for (let i = entry.length - 1; i >= 0; i--) this.field.state[entry[i].cell] = entry[i].from;
    // `moves` is not refunded, and that is load-bearing rather than stingy: redo() re-pushes
    // the entry without counting it, so refunding on undo would let a player cycle undo/redo
    // down to zero and post a 0-move record.
    this.redone.push(entry);
    this.clearHints();
    this.emit({ type: 'undo' });
    this.emit({ type: 'commit' });
    return true;
  }

  redo() {
    if (this.deadAt) return false;
    const entry = this.redone.pop();
    if (!entry) return false;
    for (const step of entry) this.field.state[step.cell] = step.to;
    this.history.push(entry);
    this.emit({ type: 'redo' });
    this.emit({ type: 'commit' });
    return true;
  }

  clearHints() {
    this.view.hints.clear();
  }

  // A hint is not "here is a cell": it asks the same solver the board was admitted by, so
  // the suggestion is provably derivable and the explanation names the rule that got there.
  hint() {
    if (this.over()) return null;
    const at = (i) => `${(((i / this.puzzle.w) | 0) + 1)}行${(i % this.puzzle.w) + 1}列`;
    // With nothing opened the solver has no clue to read, and "推不动" would be a lie: the
    // lit cell is safe by the rule the board was built with. Hand it over as a step, and do
    // not charge a hint for it — it is the game's own promise, not a deduction the player
    // could have missed.
    if (!this.hasOpened()) {
      const cell = this.puzzle.start;
      this.dig(cell);
      this.view.hints.add(cell);
      this.emit({ type: 'hint', cell, kind: 'safe' });
      return {
        text: `<b>${at(cell)}</b> 是开局一定安全的一格：布雷时把它的周围八格全留空了。挖开它，线索才会出现。`,
        cells: [cell],
        kind: 'safe',
        forced: true,
        free: true,
      };
    }
    const found = nextHint(this.field);
    this.view.hints.clear();
    if (!found) {
      return { text: '这里没有白给的一步：先核对哪个数字已经满足，再试相邻两数相减。', cells: [], forced: false };
    }
    this.hintsUsed++;
    if (found.kind === 'safe') {
      // Through the normal action, so a hinted cell is part of the board's history and the
      // undo stack stays consistent with what is on screen.
      if (!this.hasOpened()) this.dig(this.puzzle.start);
      this.dig(found.cell);
    } else if (found.kind === 'unflag') {
      this.unflag(found.cells || [found.cell]);
    } else {
      let guard = 0;
      while (this.field.state[found.cell] !== FLAG && guard++ < 3) this.flag(found.cell);
    }
    this.view.hints.add(found.cell);
    this.emit({ type: 'hint', cell: found.cell, kind: found.kind });
    return { text: found.rule, cells: [found.cell], kind: found.kind, forced: true };
  }

  // How much of the board is still unwon, and how much of it is safe — the difference
  // between "you still have work" and "you still have a guess to make".
  remaining() {
    let hidden = 0;
    let hiddenSafe = 0;
    for (let i = 0; i < this.field.state.length; i++) {
      if (this.field.state[i] === OPEN) continue;
      hidden++;
      if (!this.field.mines[i]) hiddenSafe++;
    }
    return { hidden, hiddenSafe };
  }

  // Which mines the player never named — the loss screen shows these so the board explains
  // itself instead of just ending.
  missedMines() {
    const out = [];
    for (let i = 0; i < this.field.mines.length; i++)
      if (this.field.mines[i] && this.field.state[i] !== FLAG) out.push(i);
    return out;
  }

  state() {
    return this.field.state;
  }

  reset() {
    this.field = fieldOf(this.puzzle);
    this.history.length = 0;
    this.redone.length = 0;
    this.move = null;
    this.moves = 0;
    this.hintsUsed = 0;
    this.startedAt = 0;
    this.pausedAt = 0;
    this.pausedTotal = 0;
    this.finishedAt = 0;
    this.deadAt = 0;
    this.view.hints.clear();
    this.view.boom = -1;
    this.view.cursor = null;
    this.view.reveal = false;
  }
}
