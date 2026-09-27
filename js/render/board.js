// Canvas board. Geometry is derived from the container on every resize (never a fixed
// pixel count) so a 30×16 on a phone and on a desktop are the same game, and every colour
// comes from theme.js.
//
// Reading order matters here: a player scans a minesweeper field by *shape* first (opened
// vs hidden vs flagged) and reads digits second, so the three states differ in fill and
// relief, not only in ink.

import { Palette as P, Space, Radius, Motion, Font, Cell, prefersReducedMotion } from '../theme.js';
import { OPEN, FLAG, QUESTION } from '../engine/field.js';

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export class BoardView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.geo = null;
    this.pulses = new Map();
    this.w = 0;
    this.h = 0;
    this.winAt = 0;
    this.boomAt = 0;
  }

  layout(field, availW, availH) {
    const byWidth = (availW - Space.inner * 2) / field.w;
    const byHeight = (availH - Space.inner * 2) / field.h;
    // The floor is a legibility rule, not a preference: below ~17px a digit and a mine are
    // the same smudge, so a 30-wide board on a phone scrolls instead of becoming unreadable.
    const cell = Math.max(Cell.min, Math.min(Cell.max, Math.floor(Math.min(byWidth, byHeight))));
    this.w = field.w;
    this.h = field.h;
    this.geo = {
      cell,
      originX: Space.inner,
      originY: Space.inner,
      boardW: cell * field.w,
      boardH: cell * field.h,
      w: Math.round(cell * field.w + Space.inner * 2),
      h: Math.round(cell * field.h + Space.inner * 2),
    };
    const g = this.geo;
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    this.canvas.style.width = g.w + 'px';
    this.canvas.style.height = g.h + 'px';
    this.canvas.width = Math.round(g.w * dpr);
    this.canvas.height = Math.round(g.h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return g;
  }

  hitTest(px, py) {
    const g = this.geo;
    if (!g) return null;
    if (px < g.originX || py < g.originY) return null;
    const x = Math.floor((px - g.originX) / g.cell);
    const y = Math.floor((py - g.originY) / g.cell);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    return { cell: y * this.w + x, x, y };
  }

  pulse(cell, kind, now) {
    if (!prefersReducedMotion()) this.pulses.set(cell, { kind, at: now });
  }

  beginWin(now) {
    this.winAt = now;
  }

  beginBoom(now) {
    this.boomAt = now;
  }

  animating(now) {
    if (this.winAt || this.boomAt) return true;
    for (const v of this.pulses.values()) if (now - v.at < Motion.pop) return true;
    return false;
  }

  render(game, now) {
    const g = this.geo;
    if (!g) return;
    const { field, view, puzzle } = game;
    const ctx = this.ctx;
    const c = g.cell;
    const w = this.w;
    const reduced = prefersReducedMotion();
    ctx.clearRect(0, 0, g.w, g.h);
    ctx.fillStyle = P.surface;
    roundRect(ctx, 0, 0, g.w, g.h, Radius.card);
    ctx.fill();

    for (let i = 0; i < field.state.length; i++) {
      const x = i % w;
      const y = (i / w) | 0;
      const px = g.originX + x * c;
      const py = g.originY + y * c;
      const st = field.state[i];
      const mine = !!field.mines[i];
      const shown =
        st === OPEN ||
        (view.reveal && mine) ||
        (view.reveal && st === QUESTION);

      if (!shown) {
        // Hidden: a raised tile. Unopened boards should look like pressure plates.
        ctx.fillStyle = st === FLAG ? 'rgba(255,192,72,0.13)' : P.surfaceLift;
        ctx.fillRect(px, py, c, c);
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(px, py, c, Math.max(1, c * 0.14));
        ctx.fillRect(px, py, Math.max(1, c * 0.14), c);
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.fillRect(px, py + c - 1, c, 1);
        ctx.fillRect(px + c - 1, py, 1, c);
        if (st === FLAG) this.drawFlag(ctx, px, py, c);
        else if (st === QUESTION) this.drawQuestion(ctx, px, py, c);
        continue;
      }

      // Open: flat and recessed, so the explored area visibly sinks below the tiles.
      ctx.fillStyle = mine ? 'rgba(220,53,69,0.22)' : 'rgba(0,0,0,0.30)';
      ctx.fillRect(px, py, c, c);
      if (mine) this.drawMine(ctx, px, py, c, view.boom === i);
      else if (field.counts[i]) {
        const n = field.counts[i];
        const t = (now - (this.pulses.get(i)?.at ?? -1e6)) / Motion.pop;
        const scale = reduced || t >= 1 ? 1 : 1 + 0.16 * Math.sin(Math.PI * t);
        ctx.fillStyle = P.numbers[Math.min(7, n - 1)];
        ctx.font = `700 ${Math.round(c * 0.62 * scale)}px ${Font.mono}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(n), px + c / 2, py + c / 2 + 0.5);
      }
    }

    for (const [i, v] of this.pulses) {
      const t = (now - v.at) / Motion.pop;
      if (t >= 1) this.pulses.delete(i);
    }

    // The opening cell is the one place where the game knows something the player does not
    // have to work out, so it says so until the first dig happens.
    if (!game.hasOpened() && puzzle.start >= 0) {
      const x = puzzle.start % w;
      const y = (puzzle.start / w) | 0;
      const t = reduced ? 0.6 : (Math.sin(now / 300) + 1) / 2;
      ctx.strokeStyle = P.accent;
      ctx.globalAlpha = 0.4 + t * 0.6;
      ctx.lineWidth = 2;
      ctx.strokeRect(g.originX + x * c + 1.5, g.originY + y * c + 1.5, c - 3, c - 3);
      ctx.globalAlpha = 1;
    }

    if (view.hints.size) {
      const t = reduced ? 0.5 : (Math.sin(now / 260) + 1) / 2;
      ctx.strokeStyle = P.hint;
      ctx.globalAlpha = 0.35 + t * 0.5;
      ctx.lineWidth = 2;
      for (const i of view.hints) {
        const x = i % w;
        const y = (i / w) | 0;
        ctx.strokeRect(g.originX + x * c + 1.5, g.originY + y * c + 1.5, c - 3, c - 3);
      }
      ctx.globalAlpha = 1;
    }

    if (view.cursor) {
      ctx.strokeStyle = P.info;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(g.originX + view.cursor.x * c + 1, g.originY + view.cursor.y * c + 1, c - 2, c - 2);
      ctx.setLineDash([]);
    }

    ctx.strokeStyle = P.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= w; x++) {
      const px = Math.round(g.originX + x * c) + 0.5;
      ctx.moveTo(px, g.originY);
      ctx.lineTo(px, g.originY + g.boardH);
    }
    for (let y = 0; y <= this.h; y++) {
      const py = Math.round(g.originY + y * c) + 0.5;
      ctx.moveTo(g.originX, py);
      ctx.lineTo(g.originX + g.boardW, py);
    }
    ctx.stroke();
    ctx.strokeStyle = P.lineHeavy;
    ctx.lineWidth = 2;
    ctx.strokeRect(g.originX - 1, g.originY - 1, g.boardW + 2, g.boardH + 2);

    // Loss: one dark front crosses the field so the mines the player missed arrive as a
    // single reveal rather than a scatter of red squares.
    if (this.boomAt) {
      const t = (now - this.boomAt) / Motion.win;
      if (t >= 1 || reduced) this.boomAt = 0;
      else {
        ctx.save();
        ctx.beginPath();
        ctx.rect(g.originX, g.originY, g.boardW, g.boardH);
        ctx.clip();
        const head = t * (g.boardW + g.boardH) * 1.4;
        for (let i = 0; i < field.mines.length; i++) {
          if (!field.mines[i]) continue;
          const x = i % w;
          const y = (i / w) | 0;
          const d = x * c + y * c;
          const k = 1 - Math.min(1, Math.abs(d - head) / (c * 2.4));
          if (k <= 0) continue;
          ctx.fillStyle = `rgba(220,53,69,${0.55 * k})`;
          ctx.fillRect(g.originX + x * c, g.originY + y * c, c, c);
        }
        ctx.restore();
      }
    }

    // Win: the mines flag themselves, which is the board showing the player the answer they
    // already proved.
    if (this.winAt) {
      const t = (now - this.winAt) / Motion.win;
      if (t >= 1 || reduced) this.winAt = 0;
      else {
        const head = t * (g.boardW + g.boardH) * 1.4;
        for (let i = 0; i < field.mines.length; i++) {
          if (!field.mines[i]) continue;
          const x = i % w;
          const y = (i / w) | 0;
          if (x * c + y * c > head) continue;
          this.drawFlag(ctx, g.originX + x * c, g.originY + y * c, c);
        }
      }
    }
  }

  drawFlag(ctx, px, py, c) {
    const m = c * 0.24;
    ctx.strokeStyle = P.accent;
    ctx.lineWidth = Math.max(1.4, c * 0.08);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(px + c * 0.38, py + m);
    ctx.lineTo(px + c * 0.38, py + c - m);
    ctx.moveTo(px + c * 0.2, py + c - m);
    ctx.lineTo(px + c * 0.62, py + c - m);
    ctx.stroke();
    ctx.fillStyle = P.filled;
    ctx.beginPath();
    ctx.moveTo(px + c * 0.42, py + m);
    ctx.lineTo(px + c * 0.8, py + c * 0.28);
    ctx.lineTo(px + c * 0.42, py + c * 0.52);
    ctx.closePath();
    ctx.fill();
  }

  drawQuestion(ctx, px, py, c) {
    ctx.fillStyle = P.inkDim;
    ctx.font = `700 ${Math.round(c * 0.58)}px ${Font.mono}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('?', px + c / 2, py + c / 2 + 0.5);
  }

  drawMine(ctx, px, py, c, fatal) {
    const cx = px + c / 2;
    const cy = py + c / 2;
    const r = c * 0.26;
    ctx.strokeStyle = fatal ? P.error : P.inkDim;
    ctx.lineWidth = Math.max(1, c * 0.06);
    ctx.beginPath();
    for (let k = 0; k < 4; k++) {
      const a = (Math.PI / 4) * k + Math.PI / 8;
      ctx.moveTo(cx - Math.cos(a) * r * 1.7, cy - Math.sin(a) * r * 1.7);
      ctx.lineTo(cx + Math.cos(a) * r * 1.7, cy + Math.sin(a) * r * 1.7);
    }
    ctx.stroke();
    ctx.fillStyle = fatal ? P.error : P.ink;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
}
