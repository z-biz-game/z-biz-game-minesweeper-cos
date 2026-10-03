// Wiring: screens, input, HUD, persistence and the verifier handle. The rules live in
// js/ui/game.js and js/engine/*, so a headless scenario and a finger on glass go through
// the same code path — there is deliberately no second implementation of "what a click
// does" for the tests to pass against.

import { applyThemeVars, setReduceMotion, Motion } from './theme.js';
import { Store } from './store.js';
import { audio } from './audio/synth.js';
import { TIERS, tierById, generate } from './engine/generate.js';
import { dateSeed, hash32 } from './engine/rng.js';
import { OPEN, FLAG, HIDDEN, QUESTION } from './engine/field.js';
import { nextHint } from './engine/solver.js';
import { Game } from './ui/game.js';
import { BoardView } from './render/board.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const fmtTime = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60
    ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    : `${m}:${String(s % 60).padStart(2, '0')}`;
};

const ui = {
  menu: $('#screen-menu'),
  game: $('#screen-game'),
  win: $('#screen-win'),
  canvas: $('#board'),
  boardWrap: $('#board-wrap'),
  tierGrid: $('#tier-grid'),
  hudName: $('#hud-name'),
  hudTier: $('#hud-tier'),
  hudMines: $('#hud-mines'),
  hudTime: $('#hud-time'),
  fill: $('#progress-fill'),
  rail: $('.progress-rail'),
  status: $('#statusline'),
  hintCount: $('#hint-count'),
  undo: $('#btn-undo'),
  redo: $('#btn-redo'),
  toasts: $('#toast-host'),
  dailyKey: $('#daily-key'),
  dailyNote: $('#daily-note'),
  resumeCard: $('#resume-card'),
  resumeName: $('#resume-name'),
  resumeTier: $('#resume-tier'),
};

let game = null;
let view = null;
let mode = 'dig';
let press = null;
let cursor = { x: 0, y: 0 };
let needsDraw = true;
let lastSecond = -1;
let saveTimer = 0;
let session = { tier: 'soldier', dailyKey: null };

// The daily rotates over the whole ladder rather than picking one size, so a player who
// only ever plays 每日一雷区 still meets every tier the generator can build.
const dailyTier = (epochDays) => TIERS[Math.abs(epochDays) % TIERS.length];

// ---------------------------------------------------------------- toasts / status
function toast(text, kind = '', ms = 2100) {
  const t = el('div', 'toast' + (kind ? ' ' + kind : ''), text);
  ui.toasts.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), Motion.base);
  }, ms);
  while (ui.toasts.children.length > 3) ui.toasts.firstChild.remove();
}

function status(html, kind = '') {
  ui.status.className = 'statusline' + (kind ? ' is-' + kind : '');
  ui.status.innerHTML = html;
}

// WebAudio and navigator.vibrate are both gated by user activation: firing them before the
// first tap does nothing and logs a console error per event, which buries the errors that
// matter. One capture-phase listener opens both.
function markActivation() {
  // Ask the browser rather than assuming the event was a human: a synthetic PointerEvent
  // reaches this listener too, and unlocking against it only produces the warning this
  // gate exists to avoid.
  const ua = navigator.userActivation;
  if (ua && !ua.hasBeenActive) return;
  audio.unlock();
}
window.addEventListener('pointerdown', markActivation, { capture: true, passive: true });
window.addEventListener('keydown', markActivation, { capture: true });

function haptic(kind) {
  const ua = navigator.userActivation;
  if (!navigator.vibrate || (ua && !ua.hasBeenActive)) return;
  navigator.vibrate(kind === 'bad' ? [14, 40, 14] : kind === 'big' ? 26 : 8);
}

// ---------------------------------------------------------------- screens
function show(name) {
  for (const s of [ui.menu, ui.game, ui.win]) s.hidden = s.dataset.screen !== name;
  needsDraw = true;
  if (name !== 'game') flushResume();
}

// ---------------------------------------------------------------- menu
function renderMenu() {
  ui.tierGrid.textContent = '';
  for (const tier of TIERS) {
    const btn = el('button', 'tier');
    btn.type = 'button';
    btn.dataset.tier = tier.id;
    btn.append(el('span', 'tier-name', tier.label));
    btn.append(el('span', 'tier-size', `${tier.w} × ${tier.h} · ${tier.mines} 雷`));
    btn.append(el('span', 'tier-blurb', tier.blurb));
    const best = Store.best(tier.id);
    btn.append(
      el('span', 'tier-best', best ? `最佳 ${fmtTime(best.ms)}${best.hints ? ` · ${best.hints} 求助` : ''}` : '未挑战')
    );
    btn.addEventListener('click', () => startTier(tier.id));
    ui.tierGrid.appendChild(btn);
  }

  const { key, epochDays } = dateSeed();
  const tier = dailyTier(epochDays);
  ui.dailyKey.textContent = `${key} · ${tier.label} ${tier.w}×${tier.h}`;
  const done = Store.dailySolved(key);
  ui.dailyNote.textContent = done ? '今日已完成，明天再来。' : '全服同一份种子，首次点击决定挖哪一格。';
  $('#btn-daily').textContent = done ? '回顾' : '开始';

  $('#st-solved').textContent = Store.data.totals.solved;
  $('#st-streak').textContent = Store.data.daily.streak;
  $('#st-time').textContent = fmtTime(Store.data.totals.ms);
  $('#st-hints').textContent = Store.data.totals.hints;

  const r = Store.resume();
  if (r) {
    ui.resumeCard.hidden = false;
    ui.resumeTier.textContent = tierById(r.tier).label;
    const pct = r.cells ? Math.round((100 * countOpen(r.board)) / r.cells) : 0;
    ui.resumeName.textContent = `${r.cells} 格 · 已开 ${pct}% · 用时 ${fmtTime(r.elapsedMs)}`;
  } else {
    ui.resumeCard.hidden = true;
  }
}

function countOpen(state) {
  let n = 0;
  for (const s of state) if (s === OPEN) n++;
  return n;
}

// ---------------------------------------------------------------- start / resume
async function begin({ tier, seed, dailyKey, puzzle: given, restore }) {
  session.tier = tier;
  session.dailyKey = dailyKey || null;
  show('game');
  const t = tierById(tier);
  status('<b>正在勘察雷区…</b> 生成器要用求解器把每一局验成零猜测');
  ui.hudName.textContent = '…';
  ui.hudTier.textContent = t.label;
  // Yield one frame so the "generating" line actually paints: on the dense tiers this
  // loop runs the solver dozens of times, and without the yield the HUD just freezes.
  await new Promise((r) => requestAnimationFrame(() => r()));

  let puzzle = given || null;
  if (!puzzle) {
    let made = generate(tier, seed);
    if (!made) {
      // The generator scores candidates with the same solver that proves the board is
      // guess-free, so null means the seed found nothing inside its budget. Falling back
      // to the easiest tier is honest: a small board beats a board nobody can finish.
      made = generate('trainee', seed + '#fallback');
      if (!made) {
        status('这台设备上没能生成雷区，稍后再试。', 'bad');
        return null;
      }
      toast('该种子没能凑出达标雷区，已换一处新兵雷场');
    }
    puzzle = made;
  }

  game = new Game(puzzle, restore ? restore.board : null);
  view = new BoardView(ui.canvas);
  if (restore) {
    game.startedAt = performance.now() - (restore.elapsedMs || 0);
    // The board came back; so must its cost. A resumed run that counted from zero would
    // report fewer 求助 than it took, and 求助 is what decides a best time.
    game.moves = restore.moves || 0;
    game.hintsUsed = restore.hints || 0;
  }
  if (!restore) game.start();
  resize();
  wireGameEvents();
  ui.hudName.textContent = `${puzzle.w}×${puzzle.h} 雷区`;
  ui.hudTier.textContent = `${t.label} · ${puzzle.mineCount} 雷 · 难度分 ${puzzle.stats.score}`;
  cursor = { x: puzzle.start % puzzle.w, y: (puzzle.start / puzzle.w) | 0 };
  game.view.cursor = null;
  setMode(game.hasOpened() ? mode : 'dig');
  status(
    game.hasOpened()
      ? '回到上次的雷区。旗子还在原处，继续推。'
      : `先挖亮起来的<b>那一格</b> —— 它和它周围八格一定没有雷，这一挖必然开花。`
  );
  lastSecond = -1;
  syncHud();
  needsDraw = true;
  return game;
}

function startTier(tier, opts = {}) {
  const seed =
    opts.seed || `${tier}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  return begin({ tier, seed });
}

function startDaily() {
  const { key, epochDays } = dateSeed();
  return begin({ tier: dailyTier(epochDays).id, seed: `daily|${key}`, dailyKey: key });
}

function flushResume() {
  clearTimeout(saveTimer);
  // moves, not history.length: an action only reaches history when it closes, so a
  // length check here silently skips the very first dig of every board. A finished or
  // blown run has nothing to continue, so it stops overwriting the save instead.
  if (!game || game.over() || !game.moves) return;
  Store.saveResume(game.puzzle, game.state(), game.elapsed(), { moves: game.moves, hints: game.hintsUsed });
}

function persistResume() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushResume, 400);
}

// ---------------------------------------------------------------- HUD
function syncHud() {
  if (!game) return;
  const pr = game.progress();
  const pct = Math.round(pr.ratio * 100);
  const left = game.minesLeft();
  ui.hudMines.innerHTML = `<b>${left}</b>雷`;
  ui.hudMines.classList.toggle('is-over', left < 0);
  ui.fill.style.width = pct + '%';
  ui.rail.classList.toggle('is-done', pr.opened === pr.safe);
  ui.hintCount.textContent = game.hintsUsed;
  ui.undo.disabled = !game.history.length || !!game.deadAt;
  ui.redo.disabled = !game.redone.length || !!game.deadAt;
  needsDraw = true;
}

function loop(now) {
  requestAnimationFrame(loop);
  if (ui.game.hidden || !game || !view) return;
  if (!game.over()) {
    const secs = Math.floor(game.elapsed(now) / 1000);
    if (secs !== lastSecond) {
      lastSecond = secs;
      ui.hudTime.textContent = fmtTime(game.elapsed(now));
    }
  }
  const animating = view.animating(now);
  if (needsDraw || animating) {
    view.render(game, now);
    needsDraw = false;
  }
}

function resize() {
  if (!game || !view) return;
  view.layout(
    game.field,
    ui.boardWrap.clientWidth - 8,
    Math.min(ui.boardWrap.clientHeight || 640, window.innerHeight * 0.62)
  );
  needsDraw = true;
}

// ---------------------------------------------------------------- events
function wireGameEvents() {
  game.on((ev, g) => {
    const now = performance.now();
    switch (ev.type) {
      case 'open':
        view.pulse(ev.cell, 'open', now);
        audio.dig();
        haptic('tap');
        break;
      case 'flood':
        for (const c of ev.cells.slice(0, 24)) view.pulse(c, 'open', now);
        audio.flood(ev.cells.length);
        haptic('big');
        status(`一挖推开 <b>${ev.cells.length}</b> 格 —— 0 的意思是周围八格全空，所以整片都能翻开。`, 'good');
        break;
      case 'flag':
        view.pulse(ev.cell, 'flag', now);
        audio.flag();
        haptic('tap');
        status(`插旗：<b>这一格是雷</b>。旗数会从上方的雷数里扣掉。`);
        break;
      case 'question':
        audio.dig();
        status('问号是给自己看的备忘，不算雷数。');
        break;
      case 'unflag':
        audio.unflag();
        break;
      case 'autoFlag':
        for (const c of ev.cells) view.pulse(c, 'flag', now);
        audio.flag();
        status(`有 <b>${ev.cells.length}</b> 格的线索已经推满，旗自动补上了。`, 'good');
        break;
      case 'chord':
        audio.chord();
        for (const c of ev.cells) view.pulse(c, 'open', now);
        status(`和弦开花：数字周围的旗正好对上，剩下的 <b>${ev.cells.length}</b> 格一起翻开。`);
        break;
      case 'boom':
        view.beginBoom(now);
        view.pulse(ev.cell, 'boom', now);
        audio.boom();
        haptic('bad');
        ui.boardWrap.classList.add('shake');
        setTimeout(() => ui.boardWrap.classList.remove('shake'), 340);
        status('<b>踩雷了。</b> 这一局的每一条线索都是能推到底的 —— 下面告诉你漏了哪一步。', 'bad');
        onBoom();
        break;
      case 'refuse':
        audio.error();
        haptic('bad');
        status(refused(ev.reason, ev.cell), 'bad');
        break;
      case 'hint':
        audio.hint();
        break;
      case 'win':
        view.beginWin(now);
        audio.win();
        haptic('big');
        onWin();
        break;
      case 'commit':
        syncHud();
        persistResume();
        break;
      default:
        break;
    }
  });
}

const refused = (reason, cell) => {
  // The same "3行5列" spelling the hint rules use, so the two channels that name a cell
  // cannot drift into looking like two different coordinate systems.
  const at =
    cell === undefined || !game
      ? ''
      : `<b>${Math.floor(cell / game.puzzle.w) + 1}行${(cell % game.puzzle.w) + 1}列</b>`;
  switch (reason) {
    case 'first':
      return '第一下要挖亮着的那一格：雷是按它来布的，换一格就没有"首次点击必安全"了。';
    case 'nodig':
      return '还没有翻开任何格子，此时插旗只能是猜 —— 这局不需要猜，先挖。';
    case 'open':
      return `${at} 已经翻开了。`;
    case 'flagged':
      return `${at} 插着你自己的旗 —— 先拔掉再挖，别一指尖撞翻自己认定的雷。`;
    case 'closed':
      return `${at} 还没翻开，和弦只对数字起作用。`;
    case 'empty':
      return `${at} 是 0，它周围本来就没有雷，不用再按一下。`;
    case 'over':
      return `${at} 旗插得比数字还多，和弦拒绝执行 —— 不然就是替你猜了一次。`;
    case 'under':
      return `${at} 旗还不够数，和弦不会开：等你确定剩下的全是安全格。`;
    case 'done':
      return `${at} 周围已经没有任何未知格了。`;
    case 'finished':
      return '这一局已经结束了 —— 回菜单再看一遍这局的推理。';
    default:
      return '这一步现在做不了。';
  }
};

// ---------------------------------------------------------------- end of run
function proofLine(g) {
  const s = g.puzzle.stats;
  return `这一局生成时用了 <b>${s.passes}</b> 轮推理推到安全格全开，其中用到了 ${s.kinds
    .map((k) => ({ clue: '单线索', subset: '两数相减', budget: '雷数总账' })[k])
    .join('、')}。3BV（完美玩家的最少点击数）= <b>${s.threeBV}</b>。`;
}

function onWin() {
  const g = game;
  const p = g.puzzle;
  const ms = Math.round(g.elapsed());
  Store.clearResume();
  let dailyLine = '';
  if (session.dailyKey) {
    const r = Store.markDaily(session.dailyKey);
    dailyLine = r.isNew ? ` · 连续 <b>${r.streak}</b> 天` : ' · 今日已记过';
  }
  const better = Store.recordBest(p.tier, { ms, hints: g.hintsUsed, moves: g.moves, size: p.w });
  Store.recordSolve(ms, g.hintsUsed);
  setTimeout(() => {
    const card = document.querySelector('.win-card');
    card.classList.remove('is-bad');
    $('#win-tag').textContent = better ? '新纪录' : '完成';
    $('#win-tag').className = 'chip ' + (better ? 'chip-good' : 'chip-accent');
    $('#win-name').textContent = '雷区清空';
    $('#win-style').textContent = `${tierById(p.tier).label} · ${p.w}×${p.h} · ${p.mineCount} 雷`;
    $('#win-time').textContent = fmtTime(ms);
    $('#win-moves').textContent = g.moves;
    $('#win-hints').textContent = g.hintsUsed;
    $('#win-score').textContent = p.stats.score;
    $('#win-note').innerHTML = better
      ? `刷新了 ${tierById(p.tier).label} 的最佳成绩${dailyLine}`
      : `用时 ${fmtTime(ms)}，求助 ${g.hintsUsed} 次${dailyLine}`;
    document.querySelector('.win-proof').innerHTML = proofLine(g);
    show('win');
    renderMenu();
  }, Motion.win);
}

// A loss is a state the player has to learn from, so it explains itself: which mines went
// unflagged, and the fact that the board never required a coin flip.
function onBoom() {
  const g = game;
  const missed = g.missedMines().length;
  Store.clearResume();
  setTimeout(() => {
    const p = g.puzzle;
    const card = document.querySelector('.win-card');
    card.classList.add('is-bad');
    $('#win-tag').textContent = '踩雷';
    $('#win-tag').className = 'chip chip-bad';
    $('#win-name').textContent = '排雷中断';
    $('#win-style').textContent = `${tierById(p.tier).label} · ${p.w}×${p.h} · ${p.mineCount} 雷`;
    const pr = g.progress();
    $('#win-time').textContent = fmtTime(Math.round(g.elapsed()));
    $('#win-moves').textContent = g.moves;
    $('#win-hints').textContent = g.hintsUsed;
    $('#win-score').textContent = p.stats.score;
    $('#win-note').innerHTML = `已推开 ${pr.opened}/${pr.safe} 格，还有 ${missed} 颗雷没插上旗。`;
    document.querySelector('.win-proof').innerHTML =
      `这局的雷区在发到你手上之前，已被同一个求解器从首次点击推到安全格全部翻开，用了 <b>${p.stats.passes}</b> 轮推理。` +
      `所以踩雷不是运气：<b>有一步没推完</b>。回去核对那个数字周围的旗，或者按 <code>H</code> 让它说出用的是哪条规则。`;
    show('win');
    renderMenu();
  }, Motion.win);
}

// ---------------------------------------------------------------- input
ui.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function actOn(cell, viaRight) {
  if (!game || game.over()) return;
  const wantFlag = viaRight || mode === 'flag';
  const res = wantFlag ? game.flag(cell) : game.tap(cell, 'dig');
  if (!res.refused) game.clearHints();
  needsDraw = true;
  syncHud();
}

ui.canvas.addEventListener('pointerdown', (ev) => {
  if (!game || game.over()) return;
  ev.currentTarget.setPointerCapture(ev.pointerId);
  const rect = ui.canvas.getBoundingClientRect();
  const hit = view.hitTest(ev.clientX - rect.left, ev.clientY - rect.top);
  if (!hit) return;
  cursor = { x: hit.x, y: hit.y };
  game.view.cursor = { ...cursor };
  const right = ev.button === 2 || ev.buttons === 2;
  const erase = ev.button === 1 || ev.shiftKey;
  press = { cell: hit.cell, timer: 0, fired: false, pending: false };

  if (erase) {
    // Middle-click / shift-click clears a mark back to plain hidden without spending a
    // guess on it — the one action here that must never place a flag.
    let guard = 0;
    while (game.field.state[hit.cell] !== HIDDEN && game.field.state[hit.cell] !== OPEN && guard++ < 4)
      game.flag(hit.cell);
    needsDraw = true;
    syncHud();
    return;
  }
  if (right) {
    actOn(hit.cell, true);
    return;
  }
  if (ev.pointerType === 'touch' && game.field.state[hit.cell] !== OPEN) {
    // On glass the press itself is ambiguous — a thumb resting on a cell means "flag", a
    // quick one means "dig" — so a touch dig waits for the release and a hold claims the
    // cell for a flag. Mouse keeps firing on press, where right-click already disambiguates.
    press.pending = true;
    press.timer = setTimeout(() => {
      if (!press || press.fired || !press.pending) return;
      press.fired = true;
      game.flag(press.cell);
      toast('长按 → 插旗');
      needsDraw = true;
      syncHud();
    }, 380);
  } else {
    actOn(hit.cell, false);
  }
});

ui.canvas.addEventListener('pointermove', (ev) => {
  if (!game || !press) return;
  const rect = ui.canvas.getBoundingClientRect();
  const hit = view.hitTest(ev.clientX - rect.left, ev.clientY - rect.top);
  if (!hit || hit.cell === press.cell) return;
  clearTimeout(press.timer);
  // Dragging off the cell cancels the held press. Minesweeper has no drag action, so a
  // moving finger must never dig a second cell.
  press.pending = false;
});

const endPress = () => {
  if (!press) return;
  clearTimeout(press.timer);
  if (press.pending && !press.fired) actOn(press.cell, false);
  press = null;
  needsDraw = true;
};
ui.canvas.addEventListener('pointerup', endPress);
ui.canvas.addEventListener('pointercancel', endPress);
window.addEventListener('pointerup', endPress);

// Keyboard play: arrows only move the marker, Enter commits. Digging on every arrow press
// would turn navigation into input and make undo meaningless.
window.addEventListener('keydown', (ev) => {
  if (!$('#help-sheet').hidden && ev.key === 'Escape') {
    $('#help-sheet').hidden = true;
    return;
  }
  if (ui.game.hidden || !game) return;
  const p = game.puzzle;
  const k = ev.key.toLowerCase();
  const move = (dx, dy) => {
    ev.preventDefault();
    cursor.x = Math.max(0, Math.min(p.w - 1, cursor.x + dx));
    cursor.y = Math.max(0, Math.min(p.h - 1, cursor.y + dy));
    game.view.cursor = { ...cursor };
    needsDraw = true;
  };
  if (k === 'arrowleft') move(-1, 0);
  else if (k === 'arrowright') move(1, 0);
  else if (k === 'arrowup') move(0, -1);
  else if (k === 'arrowdown') move(0, 1);
  else if (k === ' ' || k === 'enter') {
    ev.preventDefault();
    actOn(cursor.y * p.w + cursor.x, false);
  } else if (k === 'f') setMode(mode === 'dig' ? 'flag' : 'dig');
  else if (k === 'z') game.undo();
  else if (k === 'y') game.redo();
  else if (k === 'h') useHint();
  else if (k === 'escape') {
    show('menu');
    renderMenu();
  }
});

function setMode(m) {
  mode = m;
  for (const o of document.querySelectorAll('.seg-btn')) o.classList.toggle('is-on', o.dataset.mode === m);
}

function useHint() {
  if (!game || game.over()) return;
  const h = game.hint();
  if (!h) {
    status('已经推到底了 —— 剩下的格子没有未知数。', 'good');
    return;
  }
  status(h.text + (h.forced ? ' <b>（可证明的一步）</b>' : ''), h.forced ? 'good' : '');
  needsDraw = true;
  syncHud();
}

// ---------------------------------------------------------------- controls
$('#btn-back').addEventListener('click', () => {
  show('menu');
  renderMenu();
});
$('#btn-undo').addEventListener('click', () => game && game.undo());
$('#btn-redo').addEventListener('click', () => game && game.redo());
$('#btn-hint').addEventListener('click', useHint);
$('#btn-restart').addEventListener('click', () => {
  if (!game) return;
  const p = game.puzzle;
  game.reset();
  Store.clearResume();
  cursor = { x: p.start % p.w, y: (p.start / p.w) | 0 };
  game.start();
  syncHud();
  status('同一处雷区，从零开始。先挖亮着的那一格。');
  needsDraw = true;
});
for (const b of document.querySelectorAll('.seg-btn')) {
  b.addEventListener('click', () => {
    setMode(b.dataset.mode);
    toast(mode === 'dig' ? '挖开：点数字即为和弦' : '插旗：标出你确定的雷');
  });
}
$('#btn-next').addEventListener('click', () => startTier(session.tier));
$('#btn-again').addEventListener('click', () => {
  if (!game) return;
  begin({ tier: game.puzzle.tier, puzzle: game.puzzle }).then((g) => g && toast('同一处雷区，从零开始'));
});
$('#btn-home').addEventListener('click', () => {
  show('menu');
  renderMenu();
});
$('#btn-resume').addEventListener('click', async () => {
  const r = Store.resume();
  if (!r) return;
  const made = generate(r.tier, r.seed);
  if (!made) {
    toast('这片雷区已经取不到了', 'bad');
    Store.clearResume();
    renderMenu();
    return;
  }
  await begin({
    tier: r.tier,
    seed: r.seed,
    puzzle: made,
    restore: { board: r.board, elapsedMs: r.elapsedMs, moves: r.moves, hints: r.hints },
  });
});
$('#btn-resume-drop').addEventListener('click', () => {
  Store.clearResume();
  renderMenu();
});
$('#btn-daily').addEventListener('click', () => startDaily());

$('#opt-sound').addEventListener('change', (e) => {
  Store.setSetting('sound', e.target.checked);
  audio.setEnabled(e.target.checked);
  if (e.target.checked) audio.hint();
});
$('#opt-autoflag').addEventListener('change', (e) => {
  Store.setSetting('autoFlag', e.target.checked);
  // Deliberately not retroactive: flags added now would either join an older undo entry or
  // appear as a step the player never took, so the switch starts working on the next action.
  status(e.target.checked ? '从下一步开始，推满的线索会自动补旗。' : '自动补旗已关闭，那些旗由你自己插。');
});
$('#opt-question').addEventListener('change', (e) => Store.setSetting('question', e.target.checked));
$('#opt-motion').addEventListener('change', (e) => {
  Store.setSetting('reduceMotion', e.target.checked);
  setReduceMotion(e.target.checked);
});
$('#btn-help').addEventListener('click', () => ($('#help-sheet').hidden = false));
$('#btn-help-close').addEventListener('click', () => ($('#help-sheet').hidden = true));
$('#btn-reset').addEventListener('click', () => {
  Store.reset();
  renderMenu();
  toast('记录已清空');
});

document.addEventListener('visibilitychange', () => {
  if (!game) return;
  if (document.hidden) {
    game.pause();
    // Synchronous: a backgrounded tab can be discarded at any moment, and a debounced
    // write is a board the player dug but never gets back.
    flushResume();
  } else {
    game.resume();
    lastSecond = -1;
  }
});

window.addEventListener('pagehide', flushResume);
window.addEventListener('resize', () => resize());

// ---------------------------------------------------------------- verifier handle
// Everything the headless harness asserts against runs through here, and every entry
// point is the same function a click calls. There is no test-only second implementation
// of the rules — that is the difference between a passing test and a working game.
window.minesweeper = {
  version: '1.0.0',
  bootedAt: Date.now(),
  TIERS,
  tierById,
  dailyTier,
  Store,
  audio,
  HIDDEN,
  OPEN,
  FLAG,
  QUESTION,
  Game,
  BoardView,
  begin,
  startTier,
  startDaily,
  useHint,
  setMode,
  toast,
  engine: { generate, nextHint, dateSeed, hash32 },
  get game() {
    return game;
  },
  get view() {
    return view;
  },
  state() {
    if (!game) return null;
    const p = game.puzzle;
    return {
      tier: p.tier,
      seed: p.originSeed,
      w: p.w,
      h: p.h,
      mineCount: p.mineCount,
      start: p.start,
      score: p.stats.score,
      passes: p.stats.passes,
      threeBV: p.stats.threeBV,
      relaxed: p.relaxed,
      tries: p.tries,
      board: Array.from(game.state()),
      mines: Array.from(p.mines),
      progress: game.progress(),
      minesLeft: game.minesLeft(),
      moves: game.moves,
      hints: game.hintsUsed,
      history: game.history.length,
      finished: !!game.finishedAt,
      dead: !!game.deadAt,
      elapsed: Math.round(game.elapsed()),
    };
  },
  // Play a cell through the same rules path a finger uses.
  tap(cell) {
    if (!game) return false;
    actOn(cell, false);
    return true;
  },
  dig(cell) {
    if (!game) return false;
    const res = game.dig(cell);
    syncHud();
    needsDraw = true;
    return res;
  },
  flag(cell) {
    if (!game) return false;
    const res = game.flag(cell);
    syncHud();
    needsDraw = true;
    return res;
  },
  chord(cell) {
    if (!game) return false;
    const res = game.chordAt(cell);
    syncHud();
    needsDraw = true;
    return res;
  },
  // Clear the board using the shipped hint solver, one real action at a time. This is the
  // proof that the generator's promise survives contact with the game's own rules layer:
  // if the board were guessable, this would run out of derivable steps before it won.
  solveWithLogic(limit = 4000) {
    if (!game) return false;
    if (!game.hasOpened()) game.dig(game.puzzle.start);
    let steps = 0;
    while (!game.over() && steps++ < limit) {
      const found = nextHint(game.field);
      if (!found) break;
      if (found.kind === 'safe') game.dig(found.cell);
      else if (found.kind === 'unflag') game.unflag(found.cells || [found.cell]);
      else game.flag(found.cell);
    }
    syncHud();
    needsDraw = true;
    return { steps, won: !!game.finishedAt, left: game.remaining() };
  },
  undo: () => game && game.undo(),
  redo: () => game && game.redo(),
  reset: () => game && game.reset(),
  show,
  screen() {
    return ui.menu.hidden ? (ui.game.hidden ? 'win' : 'game') : 'menu';
  },
  hud() {
    return {
      name: ui.hudName.textContent,
      tier: ui.hudTier.textContent,
      time: ui.hudTime.textContent,
      mines: ui.hudMines.textContent,
      fillWidth: ui.fill.style.width,
      status: ui.status.textContent,
      undoDisabled: ui.undo.disabled,
      redoDisabled: ui.redo.disabled,
      boardPx: [ui.canvas.width, ui.canvas.height],
      cardVisible: !!document.querySelector('.win-card')?.getClientRects().length,
    };
  },
};

// ---------------------------------------------------------------- boot
applyThemeVars();
setReduceMotion(Store.setting('reduceMotion'));
audio.setEnabled(Store.setting('sound'));
$('#opt-sound').checked = !!Store.setting('sound');
$('#opt-autoflag').checked = Store.setting('autoFlag') !== false;
$('#opt-question').checked = !!Store.setting('question');
$('#opt-motion').checked = !!Store.setting('reduceMotion');
renderMenu();
show('menu');
requestAnimationFrame(loop);

// ---- 全屏开关（#btn-fullscreen）----
// 绑的是本页 HUD 上真实存在的那个按钮。全屏最常见的假实现就是引用一个并不存在的
// id：点下去什么也不会发生，量具却算它"已实现"。所以这里找不到按钮就直接不装。
(function bindFullscreen() {
  const btn = document.getElementById('btn-fullscreen');
  if (!btn) return;
  const root = document.documentElement;
  // 只做特性检测，不嗅探 UA：iOS Safari 是 webkitRequestFullscreen，老 Edge 是 ms 前缀，
  // 而 UA 字符串随时会改。"有没有这个能力"是查出来的，不是猜出来的。
  const req = root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  const current = () => document.fullscreenElement || document.webkitFullscreenElement
    || document.msFullscreenElement || null;

  // 不支持也要给个说法：只把按钮灰掉而不解释，玩家会以为这功能没做完。
  const unsupported = () => {
    btn.disabled = true;
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」独立打开）';
  };
  if (!req) unsupported();

  // fullscreen 返回 Promise，被拒时必须吃掉：iOS Safari 对多数非 video 元素直接拒绝，
  // 让这个 rejection 冒泡出去会变成一条未捕获错误，整局游戏跟着挂。
  const settle = (p) => { if (p && p.catch) p.catch(unsupported); };

  // 进出都能走：已经全屏时这次调用是退出，不是"再进一次"。
  function toggle() {
    try {
      if (current()) {
        if (exit) settle(exit.call(document));
      } else if (req) {
        settle(req.call(root));
      } else {
        unsupported();
      }
    } catch (e) {
      unsupported();
    }
  }

  // Esc 和系统手势退出都不经过我们的代码，按钮状态只能靠 fullscreenchange 回写，
  // 否则用户已经退出、HUD 还停在"退出全屏"，下一次点击反而会重新进全屏。
  function sync() {
    const on = !!current();
    btn.setAttribute('aria-pressed', String(on));
    // 图标按钮不换字形（换字形会把 HUD 的视觉语言换掉），改成把可读名与提示写回无障碍属性。
    const say = on ? "退出全屏" : "全屏";
    btn.setAttribute('aria-label', say);
    btn.title = say + '（F）';
    const body = document.body;
    if (body && body.classList) body.classList.toggle('fullscreen', on);
  }

  btn.addEventListener('click', toggle);
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'f' && ev.key !== 'F') return;
    const t = ev.target;
    // 盘号 / 种子这类输入框里打字不能触发全屏，否则玩家输 seed 输到一半屏幕没了。
    if (t && /input|textarea|select/i.test(t.tagName || '')) return;
    if (ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    ev.preventDefault();
    toggle();
  });
  window.addEventListener('fullscreenchange', sync);
  window.addEventListener('webkitfullscreenchange', sync);
  window.addEventListener('MSFullscreenChange', sync);
  sync();
})();
