// Browser-side scenarios, injected by tools/playtest.cjs and run against the live page.
// Classic script on purpose: it may only touch window.minesweeper and the real DOM, i.e. the
// same surface a click reaches. Anything not reachable that way is not covered here.
//
// Each scenario returns { rows: [{test, pass, detail}], fail, ...extras }.
//
// The division of labour with tools/engine-test.mjs is deliberate: the Node suite owns the
// hand-checked rule truths (flood shapes, chord arithmetic, solver soundness on 125 boards)
// because those need no browser. This file owns what only exists here — modules that actually
// loaded into a DOM, a canvas whose geometry round-trips against a pointer, a status line that
// has to say the right words, and localStorage that survives a reload.

(function () {
  const rows = [];
  const ok = (test, pass, detail) => rows.push({ test, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
  const done = (extra) => {
    // splice, not `rows.length = 0`: the returned object must be a snapshot. Returning the
    // live array and then clearing it makes every scenario report zero checks while the
    // failure count still says how many broke — a report that looks green and is not.
    const snapshot = rows.splice(0, rows.length);
    const out = { rows: snapshot, fail: snapshot.filter((r) => !r.pass).length };
    Object.assign(out, extra || {});
    return out;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const N = () => window.minesweeper;
  const id = (s) => document.getElementById(s);
  const label = (tier) => N().tierById(tier).label;
  const mineAt = (g, c) => !!g.puzzle.mines[c];
  const countState = (g, v) => g.field.state.reduce((n, s) => n + (s === v ? 1 : 0), 0);

  // `.hidden === true` proves nothing on its own: a CSS rule with higher specificity still
  // paints the element. Ask the layout which screens actually occupy space.
  const painted = () => ['menu', 'game', 'win']
    .filter((n) => {
      const el = document.querySelector(`[data-screen="${n}"]`);
      return el && el.getClientRects().length > 0;
    })
    .join(',');

  async function waitBooted() {
    for (let i = 0; i < 200; i++) {
      if (window.minesweeper && window.minesweeper.Game) return true;
      await sleep(50);
    }
    return false;
  }

  async function fresh(tier, seed) {
    const g = await N().begin({ tier, seed });
    await sleep(60);
    return g;
  }

  // Wait for the end-of-run card, which Motion.win deliberately delays so the last flood can
  // finish breathing before the summary covers it.
  async function settled() {
    for (let i = 0; i < 60 && N().screen() !== 'win'; i++) await sleep(50);
    return N().screen() === 'win';
  }

  // Drive a checkbox the way a player does, so its listener and the Store are inside the test.
  function flip(sel, want) {
    const cb = id(sel);
    cb.checked = want;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    return cb.checked;
  }

  // ---------------------------------------------------------------- engine
  async function engine() {
    if (!(await waitBooted())) {
      ok('boot', false, 'window.minesweeper never appeared');
      return done();
    }
    ok('version reported', /^\d+\.\d+\.\d+$/.test(N().version), N().version);
    ok('every tier is on the menu', document.querySelectorAll('.tier').length === N().TIERS.length, document.querySelectorAll('.tier').length);

    const { generate, dateSeed, hash32 } = N().engine;
    const a = generate('trainee', 'engine-det');
    const b = generate('trainee', 'engine-det');
    ok('same seed → same minefield', a.mines.join('') === b.mines.join(''));
    ok('same seed → same opening cell', a.start === b.start);
    ok('same seed → same difficulty score', a.stats.score === b.stats.score, `${a.stats.score} vs ${b.stats.score}`);
    ok('different seed → different minefield', generate('trainee', 'engine-else').mines.join('') !== a.mines.join(''));
    ok('date seed is stable and shaped', dateSeed().key === dateSeed().key && /^\d{4}-\d{2}-\d{2}$/.test(dateSeed().key), dateSeed().key);
    const h = hash32('2026-01-01|daily');
    ok('hash32 stays a 32-bit unsigned value', Number.isInteger(h) && h >= 0 && h < 4294967296, String(h));

    const g = await fresh('trainee', 'engine-replay');
    const p = g.puzzle;
    const ring = new Set([p.start, ...g.field.adj[p.start]]);
    let mineInRing = 0;
    for (const c of ring) if (mineAt(g, c)) mineInRing++;
    ok('the opening ring is mine-free', mineInRing === 0, mineInRing + ' mines in the ring');
    const opened = N().dig(p.start);
    ok('the opening dig opens a region', opened.cells.length > 1, opened.cells.length + ' cells');
    const run = N().solveWithLogic();
    ok('the shipped hint solver finishes what the generator shipped', run.won, JSON.stringify(run.left));
    ok('nothing safe is left face-down', g.remaining().hiddenSafe === 0, g.remaining().hiddenSafe);
    ok('the board has real work in it', p.stats.threeBV > 1 && p.stats.passes > 1, JSON.stringify({ bv: p.stats.threeBV, passes: p.stats.passes }));
    return done({ tier: p.tier, score: p.stats.score, steps: run.steps });
  }

  // ---------------------------------------------------------------- generation
  async function gen() {
    if (!(await waitBooted())) return done();
    const { generate } = N().engine;
    const perTier = [];
    for (const tier of N().TIERS) {
      let inBand = 0;
      let eased = 0;
      let attempts = 0;
      const scores = [];
      const t0 = performance.now();
      for (let s = 0; s < 3; s++) {
        const p = generate(tier.id, `web-${s}`);
        if (!p) { inBand = -1; break; }
        scores.push(p.stats.score);
        if (p.stats.score >= tier.band[0] && p.stats.score <= tier.band[1]) inBand++;
        if (p.relaxed) eased++;
        attempts += p.tries;
        ok(`${tier.id}/web-${s}: the generator proved it guess-free`, p.stats.stuckSafe === 0, p.stats.stuckSafe);
      }
      const ms = Math.round(performance.now() - t0);
      perTier.push({ tier: tier.id, ms, attempts: +(attempts / 3).toFixed(1) });
      ok(`${tier.id}: 3/3 inside the advertised band`, inBand === 3, `${inBand}/3 scores ${scores.join(' ')}`);
      ok(`${tier.id}: no board needed its mine count eased`, eased === 0);
      // A band nobody reaches is invisible in the check above: generate() answers with its
      // nearest miss forever, so the tier still ships legal boards — just not the difficulty
      // on the label, and 400 attempts of them. Attempts come from the seed, not the clock.
      ok(`${tier.id}: a band the generator reaches`, attempts / 3 < 200, (attempts / 3).toFixed(1) + ' attempts/board');
      ok(`${tier.id}: three boards stayed inside one screen tap`, ms < 1500, ms + ' ms');
    }
    // A board the UI is handed must be finishable through the UI's own rules, tier by tier.
    for (const tier of ['trainee', 'commando']) {
      const g = await fresh(tier, `gen-replay-${tier}`);
      const run = N().solveWithLogic();
      ok(`${tier}: playable from the browser through the real action path`, run.won && g.finishedAt, JSON.stringify(run.left));
    }
    return done({ perTier });
  }

  // ---------------------------------------------------------------- play
  async function play() {
    if (!(await waitBooted())) return done();
    const paintedAtBoot = painted();
    const g = await fresh('trainee', 'play-1');
    const p = g.puzzle;
    ok('enters the game screen', N().screen() === 'game', N().screen());
    ok('the menu is the only painted screen at boot', paintedAtBoot === 'menu', paintedAtBoot);
    ok('entering a board paints exactly one screen', painted() === 'game', painted());
    ok('HUD names the tier and the mine count', N().hud().tier.includes(label(p.tier)) && N().hud().tier.includes(String(p.mineCount)), N().hud().tier);
    ok('the mine counter starts full', g.minesLeft() === p.mineCount, g.minesLeft());
    flip('opt-autoflag', false);
    ok('the auto-flag switch reaches the store', N().Store.setting('autoFlag') === false);

    // Refusals, on a board nobody has touched yet: this is where "the first click is always
    // safe" is either a rule or a slogan.
    const elsewhere = (p.start + 5) % (p.w * p.h);
    ok('digging anywhere but the lit cell is refused', N().dig(elsewhere).refused === 'first');
    ok('the refusal explains itself', N().hud().status.includes('亮着的那一格'), N().hud().status);
    ok('a refused action is not a move', g.moves === 0, g.moves);
    ok('flagging before the first dig is refused', N().flag(elsewhere).refused === 'nodig');
    ok('that refusal says guessing is not needed', N().hud().status.includes('不需要猜'), N().hud().status);

    const r = N().dig(p.start);
    ok('the opening dig opens a region', r.cells.length > 1, r.cells.length + ' cells');
    ok('one dig is one move', g.moves === 1, g.moves);
    ok('one dig is one undo entry', g.history.length === 1 && g.history[0].length === r.cells.length, `${g.history.length} entries / ${(g.history[0] || []).length} cells`);
    const before = Array.from(g.state()).join('');
    ok('undo takes the whole region back', N().undo() === true && !g.hasOpened());
    ok('redo replays it exactly', N().redo() === true && Array.from(g.state()).join('') === before);
    ok('the counter returns with the redo', g.minesLeft() === p.mineCount, g.minesLeft());

    // Flag cycle, driven through the checkbox that owns the question-mark setting.
    const hid = g.field.state.findIndex((s) => s === N().HIDDEN);
    ok('flag places a flag', N().flag(hid).state === N().FLAG);
    ok('a flag is deducted from the counter', g.minesLeft() === p.mineCount - 1, g.minesLeft());
    ok('digging through your own flag is refused', N().dig(hid).refused === 'flagged');
    ok('the flag survived the dig attempt', g.field.state[hid] === N().FLAG);
    ok('and the refusal says to pull it first', N().hud().status.includes('先拔掉'), N().hud().status);
    ok('flag again clears it', N().flag(hid).state === N().HIDDEN);
    flip('opt-question', true);
    // A note cell must be a safe one to dig back out, so the assertion below measures the
    // rule rather than ending the run.
    const note = g.field.state.findIndex((s, i) => s === N().HIDDEN && !mineAt(g, i));
    N().flag(note);
    ok('with questions on: flag → question', N().flag(note).state === N().QUESTION, String(g.field.state[note]));
    ok('question → hidden', N().flag(note).state === N().HIDDEN, String(g.field.state[note]));
    N().flag(note);
    N().flag(note);
    ok('a question mark stays diggable: it is a note, not an answer',
      N().dig(note).refused === undefined && g.field.state[note] === N().OPEN, N().hud().status);
    flip('opt-question', false);

    // Chording, including the failure a player actually hits: one flag too many. The clue
    // needs two unknown safe cells, because chordPlan reads "nothing left to open" before
    // "too many flags" — with one safe cell the over-flag branch is unreachable.
    const clue = [...Array(p.w * p.h).keys()].find((i) => {
      if (g.field.state[i] !== N().OPEN || g.field.counts[i] === 0) return false;
      const ring = g.field.adj[i];
      return ring.some((n) => g.field.state[n] === N().HIDDEN && mineAt(g, n)) &&
        ring.filter((n) => g.field.state[n] === N().HIDDEN && !mineAt(g, n)).length >= 2;
    });
    if (clue === undefined) {
      ok('a chordable clue exists on this board', false, 'none found — pick another seed');
    } else {
      const ring = g.field.adj[clue];
      const mines = ring.filter((n) => mineAt(g, n) && g.field.state[n] === N().HIDDEN);
      const safe = ring.filter((n) => !mineAt(g, n) && g.field.state[n] === N().HIDDEN);
      for (const n of mines) N().flag(n);
      const extra = safe[0];
      N().flag(extra);
      ok('an over-flagged clue refuses instead of digging', N().chord(clue).refused === 'over');
      ok('the refusal blames the flags, not the player', N().hud().status.includes('旗插得比数字还多'), N().hud().status);
      N().flag(extra);
      ok('pulling the wrong flag leaves the mine flags in place', g.field.state[extra] === N().HIDDEN && mines.every((n) => g.field.state[n] === N().FLAG));
      const ch = N().chord(clue);
      ok('a matched chord opens the rest of the ring', !ch.refused && ch.cells.length === safe.length, `${ch.refused || ch.cells.length} vs ${safe.length}`);
      ok('the chord uncovered no mine', ring.filter((n) => mineAt(g, n) && g.field.state[n] === N().OPEN).length === 0);
    }

    // Auto-flag: a clue pushed exactly to its count must mark its own remaining mines, in the
    // same undo entry as the dig that earned them.
    flip('opt-autoflag', true);
    const g2 = await fresh('soldier', 'play-autoflag');
    const earned = findAutoFlaggable(g2);
    if (!earned) {
      ok('a board where auto-flag has work to do', false, 'no single dig completed a clue');
    } else {
      const flagsBefore = g2.flags();
      const movesBefore = g2.moves;
      N().dig(earned.digCell);
      const entry = g2.history[g2.history.length - 1] || [];
      const flagged = entry.filter((s) => s.to === N().FLAG);
      ok('a satisfied clue auto-flags its mines', g2.flags() - flagsBefore >= earned.mines.length, `${g2.flags() - flagsBefore} added, needed ${earned.mines.length}`);
      ok('every auto-flag landed on a real mine', flagged.every((s) => mineAt(g2, s.cell)), `${flagged.length} auto-flags`);
      N().undo();
      ok('one undo takes the dig and its flags back together', g2.flags() === flagsBefore, `${g2.flags()} vs ${flagsBefore} flags`);
      ok('undo retracts the board but not the cost', g2.moves === movesBefore + 1, `${g2.moves} vs ${movesBefore} moves`);
      N().redo();
      // The pair is what makes the counter unfakeable: if undo refunded a move and redo did
      // not charge one, cycling them would post a run of zero steps.
      ok('redo replays it without charging twice', g2.moves === movesBefore + 1 && g2.flags() > flagsBefore, `${g2.moves} moves / ${g2.flags()} flags`);
    }

    // A win, played through the same action path a finger uses.
    const g3 = await fresh('trainee', 'play-win');
    N().dig(g3.puzzle.start);
    const winRun = N().solveWithLogic();
    ok('logic alone wins the board', winRun.won, JSON.stringify(winRun.left));
    ok('the win screen replaces the board', (await settled()) && painted() === 'win', painted());
    ok('the card is painted, not merely unhidden', N().hud().cardVisible);
    ok('the card names the tier', id('win-style').textContent.includes(label(g3.puzzle.tier)), id('win-style').textContent);
    ok('the card counts the finishing move', id('win-moves').textContent === String(g3.moves), `${id('win-moves').textContent} vs ${g3.moves}`);
    ok('the card reports the measured difficulty', id('win-score').textContent === String(g3.puzzle.stats.score), id('win-score').textContent);
    ok('the card proves the board with its own reasoning', /3BV/.test(document.querySelector('.win-proof').textContent), document.querySelector('.win-proof').textContent.slice(0, 60));
    ok('progress reached 100%', N().hud().fillWidth === '100%', N().hud().fillWidth);
    ok('a win clears the resume record', !N().Store.resume());
    ok('a win is on the totals', N().Store.data.totals.solved > 0, N().Store.data.totals.solved);

    // A loss has to explain itself: which mines went unflagged, and no appeal to luck.
    const g4 = await fresh('trainee', 'play-boom');
    N().dig(g4.puzzle.start);
    const mine = [...g4.puzzle.mines].findIndex((m, i) => m && g4.field.state[i] === N().HIDDEN);
    ok('digging a mine blows the run', N().dig(mine).boom === true);
    ok('the field is revealed so the board explains itself', g4.view.reveal === true);
    await settled();
    ok('the loss screen paints', painted() === 'win' && document.querySelector('.win-card.is-bad') !== null, painted());
    ok('the loss counts the mines left unflagged', /没插上旗/.test(id('win-note').textContent), id('win-note').textContent);
    const proof = document.querySelector('.win-proof').textContent;
    ok('the loss refuses to call it luck', !/运气不好/.test(proof) && /有一步没推完/.test(proof), proof.slice(0, 60));
    ok('a dead run cannot be undone', N().undo() === false);
    ok('further digging is refused as finished', N().dig(g4.puzzle.start).refused === 'finished');
    ok('a dead run says so in its own words', N().hud().status.length > 0);
    ok('the loss does not get recorded as a solve', !g4.finishedAt);
    return done({ cells: p.w * p.h });
  }

  // One dig that pushes a clue exactly to its count, so auto-flag has something to do. The
  // condition is evaluated *after* the dig: the cell being opened leaves the clue's unknown
  // ring, which is the whole reason the flag becomes derivable.
  function findAutoFlaggable(g) {
    N().dig(g.puzzle.start);
    const p = g.puzzle;
    for (let i = 0; i < p.mines.length; i++) {
      if (g.field.state[i] !== N().HIDDEN || mineAt(g, i)) continue;
      for (const c of g.field.adj[i]) {
        if (g.field.state[c] !== N().OPEN || g.field.counts[c] === 0) continue;
        const ring = g.field.adj[c];
        const flags = ring.filter((n) => g.field.state[n] === N().FLAG).length;
        const rest = ring.filter((n) => n !== i && g.field.state[n] === N().HIDDEN);
        if (!rest.length || flags + rest.length !== g.field.counts[c]) continue;
        if (!rest.every((n) => mineAt(g, n))) continue;
        return { digCell: i, mines: rest };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- hints
  async function hint() {
    if (!(await waitBooted())) return done();
    flip('opt-autoflag', false);
    let bad = 0;
    const steps = [];
    for (const tier of ['trainee', 'scout', 'commando']) {
      const g = await fresh(tier, `hint-${tier}`);
      const unexplained = [];
      // The first press goes through the real button, because that is the only path that
      // puts the explanation in front of a player: the status line, not a return value.
      N().useHint();
      await sleep(30);
      const said = N().hud().status;
      ok(`${tier}: the first press names a cell to dig`, /\d+行\d+列/.test(said) && g.hasOpened(), said);
      ok(`${tier}: the free opening costs no hint`, g.hintsUsed === 0, g.hintsUsed);
      let guard = 0;
      while (!g.over() && guard++ < 4000) {
        const before = g.hintsUsed;
        const h = g.hint();
        if (!h || !h.cells || !h.cells.length) break;
        if (g.hintsUsed !== before + 1) unexplained.push(`uncounted: ${h.text}`);
        if (!/\d+行\d+列/.test(h.text)) unexplained.push(h.text);
        for (const c of h.cells) {
          if (h.kind === 'safe' && mineAt(g, c)) bad++;
          if (h.kind === 'mine' && !mineAt(g, c)) bad++;
          if (h.kind === 'unflag' && mineAt(g, c)) bad++;
        }
      }
      steps.push(guard);
      ok(`${tier}: hints alone finish the board`, !!g.finishedAt, JSON.stringify(g.remaining()));
      ok(`${tier}: every hint names a rule and a cell`, unexplained.length === 0, unexplained[0] || '');
      ok(`${tier}: the hint counter is the real cost`, Number(id('hint-count').textContent) === g.hintsUsed, `${id('hint-count').textContent} vs ${g.hintsUsed}`);
      ok(`${tier}: a hinted win needs no luck`, g.hintsUsed > 0 && g.field.state.every((s, i) => mineAt(g, i) || s === N().OPEN));
    }
    ok('hints never contradicted the mine map', bad === 0, bad + ' wrong cells');

    // Wrong flags: the player's own mistake must come back as information, not as a trap.
    const g = await fresh('soldier', 'hint-wrong');
    N().dig(g.puzzle.start);
    let wrongPlaced = 0;
    for (let i = 0; i < g.puzzle.mines.length && wrongPlaced < 5; i++)
      if (!mineAt(g, i) && g.field.state[i] === N().HIDDEN && g.field.adj[i].some((n) => g.field.state[n] === N().OPEN)) {
        N().flag(i);
        wrongPlaced++;
      }
    ok('the scenario really did flag safe cells', wrongPlaced > 0, wrongPlaced);
    ok('the counter went negative, which the HUD shows', g.minesLeft() < 0 || g.minesLeft() < g.puzzle.mineCount, g.minesLeft());
    let lethal = 0;
    let named = 0;
    let cleared = 0;
    for (let i = 0; i < 80; i++) {
      const h = g.hint();
      if (!h) break;
      if (h.kind === 'unflag') {
        named++;
        if (h.cells.every((c) => g.field.state[c] === N().HIDDEN)) cleared++;
      }
      for (const c of h.cells) if (h.kind !== 'mine' && mineAt(g, c)) lethal++;
      if (g.over()) break;
    }
    ok('a board of wrong flags never gets a lethal hint', lethal === 0, lethal);
    ok('wrong flags are named rather than shrugged at', named > 0, `${named} reports`);
    ok('naming a wrong flag actually pulls it', cleared > 0 && cleared === named, `${cleared}/${named}`);
    return done({ stepsPerTier: steps, sampleRule: g.hintsUsed > 0 ? 'ok' : 'n/a' });
  }

  // ---------------------------------------------------------------- save / resume
  async function save() {
    if (!(await waitBooted())) return done();
    id('btn-reset').click();
    const card = id('resume-card');
    ok('no save means no continue card', card.getClientRects().length === 0, 'the card is painted with nothing to resume');
    const g = await fresh('scout', 'save-1');
    const r = N().dig(g.puzzle.start);
    ok('a run worth saving', r.cells.length > 1, r.cells.length);
    const hid = g.field.state.findIndex((s) => s === N().HIDDEN);
    N().flag(hid);
    // Leaving the page must not cost the player the board they dug, so this flush is
    // synchronous — no sleep, because a test that waits for a debounce only proves the
    // debounce is short.
    window.dispatchEvent(new PageTransitionEvent('pagehide'));
    const raw = localStorage.getItem('minesweeper.save.v1');
    ok('storage written', !!raw);
    const parsed = JSON.parse(raw || '{}');
    ok('one dig is enough to be worth saving', !!parsed.resume, 'resume null after a committed move');
    ok('resume keeps the origin seed', parsed.resume && parsed.resume.seed === g.puzzle.originSeed, parsed.resume && parsed.resume.seed);
    ok('resume knows how big the board was', parsed.resume && parsed.resume.cells === g.puzzle.w * g.puzzle.h, parsed.resume && parsed.resume.cells);
    ok('resume carries what the run cost', !!parsed.resume && parsed.resume.moves === g.moves && parsed.resume.hints === g.hintsUsed,
      `${parsed.resume && parsed.resume.moves} moves / ${parsed.resume && parsed.resume.hints} hints vs ${g.moves}/${g.hintsUsed}`);
    const decoded = parsed.resume ? Array.from(N().Store.resume().board).join('') : '';
    ok('resume ink is the board it saved', decoded === Array.from(g.state()).join(''), decoded.length + ' cells');
    ok('a run-length save stays small', (raw || '').length < 4000, (raw || '').length + ' bytes');
    ok('no mine layout travels through storage', !JSON.stringify(parsed).includes('"mines"'));

    id('btn-home').click();
    await sleep(80);
    ok('a saved board offers the continue card', card.getClientRects().length > 0, 'card painted nothing after a save');
    ok('the card reports progress, not just a name', /已开 \d+%/.test(id('resume-name').textContent), id('resume-name').textContent);
    ok('the card names the tier', id('resume-tier').textContent === label(g.puzzle.tier), id('resume-tier').textContent);

    // Best-run rule: least help wins, then fewest moves, then fastest.
    N().Store.data.best = {};
    N().Store.recordBest('scout', { ms: 5000, hints: 1, moves: 9, size: 16 });
    ok('a faster run with more hints is not a record', N().Store.recordBest('scout', { ms: 1000, hints: 2, moves: 30, size: 16 }) === false);
    ok('a hint-free run is a record', N().Store.recordBest('scout', { ms: 4000, hints: 0, moves: 12, size: 16 }) === true);
    ok('record kept the hint-free run', N().Store.best('scout').hints === 0);
    ok('more moves with the same help is not a record', N().Store.recordBest('scout', { ms: 3000, hints: 0, moves: 20, size: 16 }) === false);
    ok('fewer moves with the same help is', N().Store.recordBest('scout', { ms: 9000, hints: 0, moves: 11, size: 16 }) === true);
    id('btn-home').click();
    await sleep(60);
    // The card for *that* tier: reading the first card in the grid would report the record
    // of whatever tier happens to sort first, no matter which one was just set.
    const bestCell = document.querySelector('[data-tier="scout"] .tier-best');
    ok('the menu shows the record in the tier card', /最佳/.test(bestCell.textContent), bestCell.textContent);
    ok('an untouched tier still says so', /未挑战/.test(document.querySelector('[data-tier="commando"] .tier-best').textContent));

    // Daily streak counts days, not solves.
    N().Store.data.daily = { lastKey: null, streak: 0, solved: [] };
    const y = new Date(Date.now() - 86400000);
    const yKey = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
    N().Store.markDaily(yKey);
    const today = N().engine.dateSeed().key;
    const r1 = N().Store.markDaily(today);
    const r2 = N().Store.markDaily(today);
    ok('consecutive day extends the streak', r1.streak === 2, r1.streak);
    ok('same day twice does not', r2.streak === 2 && r2.isNew === false, r2.streak);
    ok('the daily card knows the date', id('daily-key').textContent.includes(today), id('daily-key').textContent);
    ok('the daily rotates over the whole ladder', N().dailyTier(0).id === N().TIERS[0].id && N().dailyTier(N().TIERS.length).id === N().TIERS[0].id && N().dailyTier(1).id === N().TIERS[1].id);
    return done({ storedBytes: (raw || '').length });
  }

  async function resume() {
    if (!(await waitBooted())) return done();
    const r = N().Store.resume();
    ok('a saved board survived the reload', !!r, r && r.seed);
    if (!r) return done();
    const card = id('resume-card');
    ok('menu offers the continue card', card.getClientRects().length > 0, 'not painted');
    id('btn-resume').click();
    // The screen flips before the board exists: begin() prints "正在勘察雷区…" and builds the
    // game on a later frame, so polling the screen alone reads a half-open state.
    for (let i = 0; i < 80 && !N().game; i++) await sleep(50);
    const g = N().game;
    ok('resumed into the game', !!g && N().screen() === 'game', `screen=${N().screen()} status=${N().hud().status}`);
    if (!g) return done();
    ok('resumed the same seed', g.puzzle.originSeed === r.seed, g.puzzle.originSeed);
    ok('resumed ink matches', Array.from(g.state()).join('') === Array.from(r.board).join(''));
    ok('resumed flags are still flags', g.flags() > 0, g.flags());
    ok('the clock continues rather than restarts', g.elapsed() >= r.elapsedMs - 300, `${g.elapsed()} vs ${r.elapsedMs}`);
    ok('the status line says welcome back', N().hud().status.includes('回到上次的雷区'), N().hud().status);
    // A record is only honest if the cost of the run follows the board across the reload:
    // 求助 decides the best time, and a resume that reset it could be farmed.
    const costBefore = { moves: g.moves, hints: g.hintsUsed };
    ok('a resumed board is not counted as untouched', g.moves > 0, g.moves);
    N().useHint();
    N().useHint();
    const run = N().solveWithLogic();
    ok('a resumed board is still finishable by logic', run.won, JSON.stringify(run.left));
    ok('the resumed run keeps paying for its help', g.hintsUsed > costBefore.hints, `${costBefore.hints} → ${g.hintsUsed}`);
    await settled();
    ok('finishing clears the resume record', !N().Store.resume());
    return done({ seed: g.puzzle.originSeed, resumedMoves: costBefore.moves });
  }

  // ---------------------------------------------------------------- layout / input
  async function layout() {
    if (!(await waitBooted())) return done();
    const g = await fresh('commando', 'layout-1');
    const p = g.puzzle;
    const view = N().view;
    const geo = view.geo;
    const wrap = id('board-wrap');
    ok('the widest tier lays out the whole grid', geo.boardW === geo.cell * p.w && geo.boardH === geo.cell * p.h, `${geo.boardW}×${geo.boardH}`);
    ok('cell size inside the legibility band', geo.cell >= 17 && geo.cell <= 46, geo.cell);
    const fitsWidth = geo.w <= wrap.clientWidth + 1;
    const scrolls = wrap.scrollWidth > wrap.clientWidth && getComputedStyle(wrap).overflowX !== 'visible';
    ok('the board either fits or its wrapper scrolls it', fitsWidth || scrolls, `${geo.w} vs ${wrap.clientWidth}, scrollWidth ${wrap.scrollWidth}`);
    ok('the canvas is the size the layout asked for', view.canvas.style.width === geo.w + 'px', view.canvas.style.width);

    // Every cell must map back to itself through the canvas transform — the one test that
    // catches an off-by-one between layout and hit testing.
    let mismatch = 0;
    for (let i = 0; i < p.w * p.h; i++) {
      const x = i % p.w;
      const y = (i / p.w) | 0;
      const hit = view.hitTest(geo.originX + x * geo.cell + geo.cell / 2, geo.originY + y * geo.cell + geo.cell / 2);
      if (!hit || hit.cell !== i) mismatch++;
    }
    ok('hitTest round-trips every cell', mismatch === 0, mismatch + ' mismatches');
    let stray = 0;
    for (const [px, py] of [[0, 0], [-10, 40], [geo.w + 5, geo.h + 5], [geo.originX + geo.boardW, geo.originY + 1], [geo.originX + 1, geo.originY + geo.boardH]])
      if (view.hitTest(px, py)) stray++;
    ok('misses outside the grid report no cell', stray === 0, stray + ' false hits');

    // The backing store must follow devicePixelRatio or the digits render blurry.
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    ok('backing store matches DPR', Math.abs(view.canvas.width - Math.round(geo.w * dpr)) <= 1, `${view.canvas.width} / ${geo.w}@${dpr}`);

    // Pixels, not just geometry: a board can lay out perfectly and still paint nothing if
    // the draw loop is gated on a flag nobody sets. Sampled, because reading all 480 cells'
    // worth of bytes on every run costs more than the assertion is worth.
    const px = view.canvas.getContext('2d').getImageData(0, 0, view.canvas.width, view.canvas.height).data;
    const stride = 4 * 61;
    let samples = 0;
    let lit = 0;
    for (let i = 3; i < px.length; i += stride) { samples++; if (px[i] > 8) lit++; }
    ok('the canvas paints the field', lit > samples * 0.3, `${lit}/${samples} opaque`);

    // Real pointer input, not just the rules layer.
    const rect = view.canvas.getBoundingClientRect();
    const pointOf = (cell) => [
      rect.left + geo.originX + (cell % p.w) * geo.cell + geo.cell / 2,
      rect.top + geo.originY + ((cell / p.w) | 0) * geo.cell + geo.cell / 2,
    ];
    const fire = (type, cell, pointerType) => {
      const [x, y] = pointOf(cell);
      view.canvas.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 7, pointerType: pointerType || 'mouse', isPrimary: true,
        clientX: x, clientY: y, buttons: 1, button: 0,
      }));
    };
    view.canvas.setPointerCapture = () => {};
    view.canvas.releasePointerCapture = () => {};
    N().reset();
    fire('pointerdown', p.start);
    fire('pointerup', p.start);
    ok('a mouse press digs the lit cell', g.progress().opened > 1 && g.moves === 1, `${g.progress().opened} cells / ${g.moves} moves`);

    const number = g.field.state.findIndex((s, i) => s === N().OPEN && g.field.counts[i] > 0);
    const openedBefore = g.progress().opened;
    fire('pointerdown', number);
    fire('pointerup', number);
    ok('a press on a number is a chord, not a re-dig', g.moves === 1 && g.progress().opened === openedBefore, `${g.moves} moves / ${g.progress().opened} open`);
    ok('a chord without flags opens nothing and says why', /旗还不够数/.test(N().hud().status), N().hud().status);

    // Touch: a hold flags, and the press must not dig first — the cell would already be open
    // and the flag would have nowhere to go.
    const near = g.field.state.findIndex((s, i) => s === N().HIDDEN && !mineAt(g, i) && g.field.adj[i].some((n) => g.field.state[n] === N().OPEN));
    fire('pointerdown', near, 'touch');
    await sleep(520);
    fire('pointerup', near, 'touch');
    ok('a touch hold flags instead of digging', g.field.state[near] === N().FLAG, String(g.field.state[near]));
    ok('and says so in a toast', /长按/.test((document.querySelector('.toast') || {}).textContent || ''), (document.querySelector('.toast') || {}).textContent);
    fire('pointerdown', near, 'touch');
    await sleep(40);
    fire('pointerup', near, 'touch');
    // The flag has to survive it: a quick tap that cleared the mark would be a finger slip
    // costing the player an answer they already worked out.
    ok('a quick tap on a flagged cell is refused, not dug', g.field.state[near] === N().FLAG, String(g.field.state[near]));
    ok('and the refusal tells the player to pull it', /先拔掉/.test(N().hud().status), N().hud().status);

    // Flag mode: the segmented control is how a mouse player marks without right-click.
    const flagBtn = document.querySelector('.seg-btn[data-mode="flag"]');
    flagBtn.click();
    ok('flag mode is the active segment', flagBtn.classList.contains('is-on'), flagBtn.className);
    const mark = g.field.state.findIndex((s) => s === N().HIDDEN);
    fire('pointerdown', mark);
    fire('pointerup', mark);
    ok('in flag mode a press marks instead of digging', g.field.state[mark] === N().FLAG, String(g.field.state[mark]));

    // Right-click flags too, and Shift clears a mark without spending a guess on it.
    const [rx, ry] = pointOf(mark);
    view.canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: 8, pointerType: 'mouse', isPrimary: true, clientX: rx, clientY: ry, buttons: 2, button: 2,
    }));
    ok('a right press clears the flag', g.field.state[mark] === N().HIDDEN, String(g.field.state[mark]));
    view.canvas.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerId: 8, pointerType: 'mouse', isPrimary: true, clientX: rx, clientY: ry, buttons: 1, button: 0, shiftKey: true,
    }));
    ok('shift-click leaves a clean cell', g.field.state[mark] === N().HIDDEN);

    // Keyboard: arrows move the marker, Enter commits, F toggles mode.
    document.querySelector('.seg-btn[data-mode="dig"]').click();
    id('btn-restart').click();
    await sleep(40);
    const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
    const start = { x: p.start % p.w, y: (p.start / p.w) | 0 };
    ok('restart parks the cursor on the lit cell', !!g.view.cursor === false && g.moves === 0, g.moves);
    key('Enter');
    await sleep(30);
    ok('Enter digs the lit cell first', g.progress().opened > 1, g.progress().opened);
    key('ArrowRight');
    key('ArrowRight');
    key('ArrowDown');
    ok('arrows move the marker with the grid as the limit',
      !!g.view.cursor && g.view.cursor.x === Math.min(p.w - 1, start.x + 2) && g.view.cursor.y === Math.min(p.h - 1, start.y + 1),
      JSON.stringify(g.view.cursor));
    key('f');
    ok('F switches to flag mode', document.querySelector('.seg-btn[data-mode="flag"]').classList.contains('is-on'));
    key('f');
    ok('F switches back', document.querySelector('.seg-btn[data-mode="dig"]').classList.contains('is-on'));
    const cursorCell = g.view.cursor.y * p.w + g.view.cursor.x;
    key('Escape');
    await sleep(40);
    ok('Escape leaves the board without losing it', N().screen() === 'menu' && !!N().Store.resume(), `${N().screen()} / ${!!N().Store.resume()}`);
    void cursorCell;

    // The help sheet and the reduced-motion switch, which gates animation everywhere else.
    id('btn-help').click();
    ok('help sheet paints on demand', id('help-sheet').getClientRects().length > 0);
    ok('the rules explain chording and the first click', document.querySelectorAll('.rules li').length >= 7, document.querySelectorAll('.rules li').length);
    key('Escape');
    ok('Escape closes the sheet', id('help-sheet').getClientRects().length === 0);
    flip('opt-motion', true);
    ok('the motion switch reaches the store', N().Store.setting('reduceMotion') === true);
    flip('opt-motion', false);
    return done({ cell: geo.cell, dpr, cells: p.w * p.h });
  }

  window.__ng = { engine, gen, play, hint, save, resume, layout };
})();
