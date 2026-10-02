#!/usr/bin/env python3
"""扫雷的视觉母题工厂 —— 一条命令重画全仓位图资产。

    python3 assets/gen/make_art.py            # 生成/覆盖
    python3 assets/gen/make_art.py --check    # 只校验盘上资产是否与脚本一致（漂移检测）

为什么在仓里自己画，而不用主编的 007_美术资产/icons：那条线把产物写进 lead 仓，而本单的硬
约束是"全部改动只准落在这个仓"。母题本身也来自玩法，不是装饰：

  探雷面板 —— 一片凸起的地砖（还没挖 = 未知），中央一块已经挖开，露出埋在下面的琥珀色雷，
  旁边两块翻开的格子说出 1 和 2。暗底 + 单一琥珀强调色 + 八格方格网格，颜色与
  js/theme.js 的 Palette 同源（#0F0F0F / #1A1A2E / #FFC048 / #74B9FF / #28A745）。

形状全用矢量几何画，只在 ≥128px 时才加数字与旗：16/32 的 tab 图标上数字会变成糊点。
所有尺寸都由同一套相对坐标推导，所以 16px 和 1024px 是同一个图形而不是两张。
噪声与纹理用自带 LCG 定种子，产物逐字节可复现（--check 就是这条断言）。
"""
import hashlib
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))

INK = (245, 245, 247)
DIM = (245, 245, 247, 153)
BG_TOP = (26, 26, 46)
BG_BOT = (15, 15, 15)
TILE = (31, 31, 46)
TILE_EDGE = (67, 67, 92)
RECESS = (10, 10, 18)
AMBER = (255, 192, 72)
AMBER_LIT = (255, 217, 138)
CLUE_1 = (116, 185, 255)
CLUE_2 = (40, 167, 69)
RED = (220, 53, 69)

SS = 4  # supersample: draw at 4x, downscale with LANCZOS for clean edges at every size


class Lcg:
    """Deterministic PRNG — Math.random()/randrange() would make the PNGs irreproducible."""

    def __init__(self, seed):
        self.s = seed & 0xFFFFFFFF

    def next(self):
        self.s = (1103515245 * self.s + 12345) & 0xFFFFFFFF
        return (self.s >> 8) & 0xFFFFFF

    def uniform(self):
        return self.next() / 16777216.0


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(len(a)))


def vertical_gradient(size, top, bottom, skew=0.62):
    """One column scaled across: a per-pixel loop at the 4x supersample sizes costs tens of
    millions of iterations to paint a flat ramp."""
    w, h = size
    col = Image.new('RGBA', (1, h))
    px = col.load()
    for y in range(h):
        px[0, y] = lerp(top, bottom, (y / max(1, h - 1)) ** skew) + (255,)
    return col.resize((w, h), Image.NEAREST)


class Paint:
    """Two drawers, because PIL cannot blend a translucent ink onto an opaque target:
    drawing (255,255,255,26) with ImageDraw overwrites the pixel — including its alpha — so a
    "highlight" becomes a transparent hole punched through the icon. Opaque marks go straight
    on the image, translucent ones on a layer that flush() composites source-over.
    """

    def __init__(self, img, flat=False):
        self.img = img
        self.fonts = {}
        self.opaque = ImageDraw.Draw(img)
        if flat:  # sprite sheet: straight alpha, nothing underneath to lighten
            self.layer = None
            self.fx = self.opaque
        else:
            self.layer = Image.new('RGBA', img.size, (0, 0, 0, 0))
            self.fx = ImageDraw.Draw(self.layer)

    def flush(self):
        if self.layer is not None:
            # alpha_composite, not paste(layer, mask=layer): the latter recomputes the alpha
            # band and leaves the "opaque" icon ~9% semi-transparent.
            self.img.paste(Image.alpha_composite(self.img, self.layer), (0, 0))


def vignette(size, rng, strength=1.0, blobs=90):
    """Corner-weighted dust + soft dark edges, both from the seeded LCG."""
    w, h = size
    acc = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(acc)
    cx, cy = w / 2, h / 2
    maxd = math.hypot(cx, cy)
    for _ in range(blobs):
        x, y = rng.uniform() * w, rng.uniform() * h
        r = (0.03 + rng.uniform() * 0.12) * w
        k = math.hypot(x - cx, y - cy) / maxd
        d.ellipse([x - r, y - r, x + r, y + r], fill=int((6 + 26 * k) * strength))
    acc = acc.filter(ImageFilter.GaussianBlur(w / 26))
    dark = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    dark.putalpha(acc)
    return dark


def draw_tile(pt, box, lifted=True, radius_frac=0.16):
    """One grid cell. Lifted = raised pressure plate; dug = recessed hole (the relief flips)."""
    x0, y0, x1, y1 = box
    s = x1 - x0
    r = s * radius_frac
    lip = max(1, int(s * 0.085))
    d = pt.opaque
    if lifted:
        d.rounded_rectangle(box, radius=r, fill=TILE, outline=TILE_EDGE,
                            width=max(1, int(s * 0.03)))
        pt.fx.rounded_rectangle([x0 + lip * 0.4, y0 + lip * 0.4, x1 - lip * 0.4, y0 + lip],
                                radius=r * 0.4, fill=(255, 255, 255, 30))
        pt.fx.rounded_rectangle([x0 + lip * 0.4, y1 - lip, x1 - lip * 0.4, y1 - lip * 0.4],
                                radius=r * 0.4, fill=(0, 0, 0, 80))
    else:
        d.rounded_rectangle(box, radius=r, fill=RECESS)
        pt.fx.rounded_rectangle([x0 + lip * 0.3, y0 + lip * 0.3, x1 - lip * 0.3, y0 + lip],
                                radius=r * 0.4, fill=(0, 0, 0, 110))
        pt.fx.rounded_rectangle([x0 + lip * 0.3, y1 - lip, x1 - lip * 0.3, y1 - lip * 0.3],
                                radius=r * 0.4, fill=(255, 255, 255, 20))


def draw_mine(pt, cx, cy, r, ink=INK, fatal=False, arm_frac=1.82):
    """Eight thin arms fused into one ball, all a single ink. On a dark field a light spiked
    ball reads as a sun, so the brand mark puts it on an amber plate (draw_mine_cell) and only
    the in-game sprite keeps the light ink — that one sits on a dark dug cell, where board.js
    already paints it, and turns Palette.error red for the cell that ended the run."""
    arm = r * arm_frac
    w = max(2, int(r * 0.15))
    d = pt.opaque
    ink = RED if fatal else ink
    for k in range(4):
        a = (math.pi / 4) * k + math.pi / 8
        d.line([cx - math.cos(a) * arm, cy - math.sin(a) * arm,
                cx + math.cos(a) * arm, cy + math.sin(a) * arm], fill=ink, width=w)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ink)


def draw_mine_cell(pt, box, ink=(16, 16, 24)):
    """The mark's focal cell: a dug-out hole whose plate is the one lit amber square on it."""
    draw_tile(pt, box, lifted=False)
    inset = (box[2] - box[0]) * 0.07
    pt.opaque.rounded_rectangle([box[0] + inset, box[1] + inset, box[2] - inset, box[3] - inset],
                                radius=(box[2] - box[0]) * 0.13, fill=AMBER)
    # arms kept inside the plate: if they reach its edge the amber turns into spokes
    draw_mine(pt, (box[0] + box[2]) / 2, (box[1] + box[3]) / 2, (box[2] - box[0]) * 0.25,
              ink=ink, arm_frac=1.42)


def draw_flag(pt, cx, cy, s, colour=AMBER):
    """Pennant on a post with a base plate — same construction as board.js drawFlag."""
    w = max(2, int(s * 0.085))
    top = cy - s * 0.42
    base = cy + s * 0.34
    px = cx - s * 0.10
    d = pt.opaque
    d.line([px, top, px, base], fill=colour, width=w)
    d.line([cx - s * 0.30, base, cx + s * 0.14, base], fill=colour, width=w)
    d.polygon([(px + w * 0.4, top), (cx + s * 0.36, top + s * 0.15), (px + w * 0.4, top + s * 0.30)],
              fill=colour)


def clue_font(size):
    for p in ('/System/Library/Fonts/SFNSMono.ttf', '/System/Library/Fonts/Menlo.ttc',
              '/Library/Fonts/Arial Mono.ttf',
              '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'):
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()


def cjk_font(size):
    for p in ('/System/Library/Fonts/PingFang.ttc',
              '/System/Library/Fonts/Hiragino Sans GB.ttc',
              '/System/Library/Fonts/STHeiti Light.ttc',
              '/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc'):
        try:
            return ImageFont.truetype(p, size, index=0)
        except OSError:
            continue
    return None


def draw_clue(pt, box, digit, colour):
    x0, y0, x1, y1 = box
    f = pt.fonts.get(int(x1 - x0)) or clue_font(int((x1 - x0) * 0.66))
    pt.fonts[int(x1 - x0)] = f
    t = str(digit)
    bb = pt.opaque.textbbox((0, 0), t, font=f)
    pt.opaque.text((x0 + (x1 - x0 - bb[2] + bb[0]) / 2 - bb[0],
                    y0 + (y1 - y0 - bb[3] + bb[1]) / 2 - bb[1]), t, font=f, fill=colour)


class Sheet:
    """A canvas plus the font cache its clues need."""

    def __init__(self, img, flat=False):
        self.img = img
        self.paint = Paint(img, flat=flat)
        self.paint.fonts = {}


def emblem(size, with_detail=True, maskable=False):
    """The whole product mark on one square canvas, from relative coordinates only."""
    S = size * SS
    img = vertical_gradient((S, S), BG_TOP, BG_BOT)
    pad = -S * 0.02 if maskable else S * 0.055
    grid_box = [pad, pad, S - pad, S - pad]
    r = 0.0 if maskable else S * 0.20

    plate = vertical_gradient((S, S), (34, 34, 54), (11, 11, 17), skew=1.0)
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle(grid_box, radius=r, fill=255)
    img.paste(plate, (0, 0), mask)

    sh = Sheet(img)
    pt = sh.paint
    pt.opaque.rounded_rectangle(grid_box, radius=r, outline=TILE_EDGE, width=max(2, int(S * 0.011)))

    gx, gy = grid_box[0], grid_box[1]
    gap = S * 0.022
    cw = (grid_box[2] - grid_box[0] - 2 * gap) / 3
    ch = (grid_box[3] - grid_box[1] - 2 * gap) / 3

    def cell_box(i, j):
        x0 = gx + j * (cw + gap)
        y0 = gy + i * (ch + gap)
        return [x0, y0, x0 + cw, y0 + ch]

    # Centre = the thing itself, already dug. Two neighbours say 1 and 2, one still carries
    # the player's flag, the rest are unknown. That is the whole game in a 3x3.
    layout = {(0, 0): 'tile', (0, 1): 'dug1', (0, 2): 'tile',
              (1, 0): 'tile', (1, 1): 'mine', (1, 2): 'flag',
              (2, 0): 'dug2', (2, 1): 'tile', (2, 2): 'tile'}
    for (i, j), kind in layout.items():
        box = cell_box(i, j)
        cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        if kind == 'mine':
            draw_mine_cell(pt, box)
        elif kind == 'flag':
            draw_tile(pt, box, lifted=True)
            if with_detail:
                draw_flag(pt, cx, cy, cw * 0.78)
        elif kind.startswith('dug') and with_detail:
            draw_tile(pt, box, lifted=False)
            draw_clue(pt, box, int(kind[3:]), CLUE_1 if kind == 'dug1' else CLUE_2)
        else:
            draw_tile(pt, box, lifted=True)
    pt.flush()

    if size >= 96:
        rng = Lcg(20261002)
        img.paste(Image.alpha_composite(img, vignette((S, S), rng, 1.0, blobs=int(S / 9))), (0, 0))
    return img.resize((size, size), Image.LANCZOS)


def sprite_sheet():
    """128px slots the canvas samples at cell size: mine, fatal mine, flag, question."""
    S, n = 128 * SS, 4
    img = Image.new('RGBA', (S * n, S), (0, 0, 0, 0))
    pt = Sheet(img, flat=True).paint
    cy = S / 2
    draw_mine(pt, S * 0.5, cy, S * 0.27)
    draw_mine(pt, S * 1.5, cy, S * 0.27, fatal=True)
    draw_flag(pt, S * 2.5, cy, S * 0.80)
    f = clue_font(int(S * 0.62))
    bb = pt.opaque.textbbox((0, 0), '?', font=f)
    pt.opaque.text((S * 3.5 - (bb[2] - bb[0]) / 2 - bb[0], cy - (bb[3] - bb[1]) / 2 - bb[1]),
                   '?', font=f, fill=DIM)
    return img.resize((S * n // SS, S // SS), Image.LANCZOS)


def grain_tile(size=256, seed=7717):
    """Tileable fine grain from a wrapped value-noise lattice — the board's surface texture."""
    rng = Lcg(seed)
    lat = 8
    grid = [[rng.uniform() for _ in range(lat)] for _ in range(lat)]

    def smooth(t):
        return t * t * (3 - 2 * t)

    img = Image.new('L', (size, size))
    px = img.load()
    cell = size / lat
    for y in range(size):
        for x in range(size):
            gx, gy = int(x / cell) % lat, int(y / cell) % lat
            fx, fy = smooth((x % cell) / cell), smooth((y % cell) / cell)
            a = grid[gy][gx] * (1 - fx) + grid[gy][(gx + 1) % lat] * fx
            b = grid[(gy + 1) % lat][gx] * (1 - fx) + grid[(gy + 1) % lat][(gx + 1) % lat] * fx
            px[x, y] = 118 + int((a * (1 - fy) + b * fy - 0.5) * 34)
    return img.convert('RGBA')


def og_card():
    """1200x630 social card: the mark, the name, and the one promise worth putting on it."""
    W, H = 1200 * 2, 630 * 2
    img = vertical_gradient((W, H), BG_TOP, BG_BOT, skew=0.9)
    rng = Lcg(4242)
    img.paste(Image.alpha_composite(img, vignette((W, H), rng, 1.1, 200)), (0, 0))

    mark = emblem(700, with_detail=True)
    mx, my = int(W * 0.058), int(H * 0.155)
    # the mark is a square bitmap with its own ramp; rounded, it sits on the card as a tile
    rounded = Image.new('L', mark.size, 0)
    ImageDraw.Draw(rounded).rounded_rectangle([0, 0, mark.size[0] - 1, mark.size[1] - 1],
                                              radius=mark.size[0] * 0.16, fill=255)
    img.paste(mark, (mx, my), rounded)

    pt = Sheet(img).paint
    tx = mx + 700 + int(W * 0.042)
    ty = int(H * 0.135)
    f_cjk, f_lat, f_sub = cjk_font(int(H * 0.215)), clue_font(int(H * 0.062)), cjk_font(int(H * 0.046))
    if f_cjk:
        pt.opaque.text((tx, ty), '扫雷', font=f_cjk, fill=INK)
        ty += int(H * 0.265)
    if f_lat:
        pt.opaque.text((tx, ty), 'M I N E S W E E P E R', font=f_lat, fill=AMBER)
        ty += int(H * 0.145)
    if f_sub:
        pt.opaque.text((tx, ty), '每一局都被同一个求解器验过：只用逻辑，不用猜', font=f_sub, fill=DIM)

    # a strip of field along the bottom: dug, flagged and mined, cropped like a photo
    band_y, bh = int(H * 0.705), int(H * 0.185)
    gap = int(bh * 0.15)
    cw = bh - gap
    room = W - 2 * mx
    n = max(1, int((room + gap) / (cw + gap)))
    x0 = (W - (n * cw + (n - 1) * gap)) / 2
    kinds = ['tile', 'dug', 'flag', 'tile', 'mine', 'tile', 'dug', 'flag', 'tile', 'dug',
             'tile', 'mine', 'dug', 'tile', 'flag', 'tile']
    digits = [1, 2, 3, 1, 2]
    clue_colours = [CLUE_1, CLUE_2, AMBER]
    dug = 0
    for i in range(n):
        box = [x0 + i * (cw + gap), band_y, x0 + i * (cw + gap) + cw, band_y + bh]
        cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
        k = kinds[i % len(kinds)]
        if k == 'dug':
            draw_tile(pt, box, False)
            draw_clue(pt, box, digits[dug % len(digits)], clue_colours[dug % len(clue_colours)])
            dug += 1
        elif k == 'flag':
            draw_tile(pt, box, True)
            draw_flag(pt, cx, cy, cw * 0.8)
        elif k == 'mine':
            draw_mine_cell(pt, box)
        else:
            draw_tile(pt, box, True)
    pt.flush()
    return img.resize((1200, 630), Image.LANCZOS)


TARGETS = [
    ('assets/img/icon-1024.png', lambda: emblem(1024)),
    ('assets/icons/icon-512.png', lambda: emblem(512)),
    ('assets/icons/icon-192.png', lambda: emblem(192)),
    ('assets/icons/icon-maskable-512.png', lambda: emblem(512, maskable=True)),
    ('assets/icons/favicon-192.png', lambda: emblem(192)),
    ('assets/icons/favicon-32.png', lambda: emblem(32, with_detail=False)),
    ('assets/icons/favicon-16.png', lambda: emblem(16, with_detail=False)),
    ('assets/icons/apple-touch-icon-180.png', lambda: emblem(180)),
    ('assets/img/og-cover.png', og_card),
    ('assets/img/sprites.png', sprite_sheet),
    ('assets/img/tile-grain.png', grain_tile),
]


def main():
    check = '--check' in sys.argv[1:]
    bad = []
    for rel, fn in TARGETS:
        dst = os.path.join(REPO, rel)
        img = fn()
        buf = os.path.join(HERE, '.render.png')
        img.save(buf, 'PNG', optimize=True)
        data = open(buf, 'rb').read()
        os.remove(buf)
        old = open(dst, 'rb').read() if os.path.exists(dst) else b''
        digest = hashlib.sha256(data).hexdigest()[:12]
        if check:
            if old != data:
                bad.append(rel)
            print('%-42s %5dx%-5d %s  %s' % (rel, img.width, img.height, digest,
                                             'match' if old == data else 'DRIFT'))
        else:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, 'wb') as fh:
                fh.write(data)
            print('%-42s %5dx%-5d %s  %d bytes' % (rel, img.width, img.height, digest, len(data)))
    if check and bad:
        print('DRIFT: %s 与脚本不一致，重跑 make_art.py' % ', '.join(bad))
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
