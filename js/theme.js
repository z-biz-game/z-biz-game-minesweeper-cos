// Single source of truth for colour, spacing and motion. The stylesheet reads these as
// custom properties (applyThemeVars) and the canvas reads the same objects, so a token
// change cannot land on one side only — which is how "one main colour" turns into forty.

export const Palette = {
  // deep base, one accent ramp
  bgTop: '#0F0F0F',
  bgBottom: '#1A1A2E',
  surface: '#171722',
  surfaceLift: '#1F1F2E',
  line: '#2B2B3D',
  lineHeavy: '#43435C',
  ink: '#F5F5F7',
  inkDim: 'rgba(245,245,247,0.60)',
  inkFaint: 'rgba(245,245,247,0.34)',

  accent: '#FFC048',
  accentSoft: 'rgba(255,192,72,0.16)',
  filled: '#FFC048',
  filledEdge: '#FFD98A',
  filledDeep: '#B87A12',
  crossed: 'rgba(245,245,247,0.22)',

  success: '#28A745',
  error: '#DC3545',
  warn: '#FFC048',
  info: '#74B9FF',
  focus: 'rgba(116,185,255,0.14)',
  hint: '#74B9FF',

  // Eight clue colours, because a player reads a minesweeper number by its hue before they
  // read the digit — but they live here rather than in the renderer so the ramp cannot
  // fork into forty copies.
  numbers: ['#74B9FF', '#28A745', '#FFC048', '#FF8A5C', '#FF5C7A', '#4DD0E1', '#F5F5F7', '#9A9AB0'],
};

export const Space = { page: 20, card: 16, inner: 12, gutter: 10 };
export const Radius = { card: 20, button: 12, chip: 8, cell: 2 };

export const Font = {
  title: "700 24px/1.25 -apple-system, 'SF Pro Display', system-ui, sans-serif",
  mono: "'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', system-ui, sans-serif",
};

// Durations obey the 150–350 ms discipline; anything longer blocks the next move.
export const Motion = {
  tap: 150,
  base: 220,
  pop: 260,
  line: 300,
  win: 900,
  spring: 'cubic-bezier(0.34, 1.45, 0.64, 1)',
  ease: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
};

export const Cell = { min: 17, max: 46, clueScale: 0.86 };

export function applyThemeVars() {
  const root = document.documentElement.style;
  const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  for (const [k, v] of Object.entries(Palette)) {
    // Arrays are canvas-only tokens (the clue ramp); there is no sane custom property for them.
    if (Array.isArray(v)) continue;
    root.setProperty('--' + kebab(k), v);
  }
  for (const [k, v] of Object.entries(Space)) root.setProperty('--space-' + k, v + 'px');
  for (const [k, v] of Object.entries(Radius)) root.setProperty('--radius-' + k, v + 'px');
  for (const [k, v] of Object.entries(Motion)) {
    if (typeof v === 'number') root.setProperty('--dur-' + kebab(k), v + 'ms');
    else root.setProperty('--ease-' + kebab(k), v);
  }
  root.setProperty('--font-mono', Font.mono);
  root.setProperty('--font-sans', Font.sans);
}

// The system preference is the floor, and the in-game toggle can only add to it — a
// player who asks for less motion should not be overruled by an OS set to "no preference".
let motionReduced = false;

export function setReduceMotion(v) {
  motionReduced = !!v;
}

export const systemPrefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const prefersReducedMotion = () => motionReduced || systemPrefersReducedMotion();
