"""
Generateur de silhouettes d'ennemis, pixel art, par code.

Deux systemes, du moins au plus lisible :

  A. "blob"     bruit pondere -> miroir -> plus grande composante connexe -> lissage.
                Aucun dessin. Variete infinie, mais les creatures se ressemblent
                toutes : la silhouette n'est pas AUTEUREE, elle est subie.

  B. "familles" un gabarit de silhouette ecrit a la main par famille (une dizaine
                de lignes d'ASCII), puis du bruit applique UNIQUEMENT sur le bord
                pour produire des variantes. La famille se lit au premier coup
                d'oeil, les variantes evitent le copier-coller.

Sortie : deux feuilles en niveaux de gris + alpha, prevues pour etre teintees
au rendu (corps clair, ombre grise, contour presque noir).
"""

import os
import random
from collections import deque

from PIL import Image

BODY, SHADE, OUTLINE, EYE = 245, 165, 22, 40

OUT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "placeholder"
)

# --------------------------------------------------------------------------
# B. Familles : demi-gabarits, colonne 0 = bord exterieur, derniere colonne =
#    axe de symetrie. '#' corps, 'o' oeil, '.' vide.
# --------------------------------------------------------------------------
FAMILIES = {
    "rampant": [
        "....####",
        "..######",
        ".#######",
        "########",
        "###o####",
        "########",
        "########",
        ".#######",
        ".##.##.#",
        ".#..#..#",
    ],
    "volant": [
        ".........",
        ".......##",
        "......###",
        "##...####",
        "####o####",
        "#########",
        "##...####",
        "......###",
        ".......##",
        "........#",
    ],
    "chargeur": [
        ".....#.",
        "....##.",
        "...###.",
        "..#####",
        "..#o###",
        ".######",
        ".######",
        "#######",
        "#######",
        ".######",
        ".##.###",
        ".#...##",
        ".#...#.",
    ],
    "colosse": [
        "......#####",
        "....#######",
        "...########",
        "..#########",
        "..###o#####",
        ".##########",
        "###########",
        "###########",
        "###########",
        "###########",
        "###########",
        ".##########",
        ".####..####",
        ".###...####",
        ".###...###.",
    ],
    "eclateur": [
        "...#...",
        "...##..",
        "..####.",
        ".######",
        "#######",
        "###o###",
        "#######",
        "#######",
        ".######",
        "..####.",
        "...##..",
        "...#...",
    ],
    "tireur": [
        "........",
        "##....##",
        "##..####",
        "##.#####",
        "...#####",
        "...#o###",
        "...#####",
        "...#####",
        "....####",
        "...#..##",
        "..#...#.",
        "..#...#.",
    ],
}


def mirror(half_rows):
    """Demi-gabarit -> grille pleine + position de l'oeil."""
    h, hw = len(half_rows), len(half_rows[0])
    w = hw * 2
    grid = [[0] * w for _ in range(h)]
    eye = None
    for y, row in enumerate(half_rows):
        for x, ch in enumerate(row):
            if ch in "#o":
                grid[y][x] = grid[y][w - 1 - x] = 1
                if ch == "o":
                    eye = (x, y)
    return grid, w, h, eye


def jitter(grid, w, h, amount, rng):
    """Bruit sur le bord uniquement : la famille reste reconnaissable."""
    out = [row[:] for row in grid]
    for y in range(h):
        for x in range(w // 2):  # on ne perturbe qu'une moitie, puis on mirroir
            n = sum(
                grid[y + dy][x + dx]
                for dy in (-1, 0, 1)
                for dx in (-1, 0, 1)
                if 0 <= y + dy < h and 0 <= x + dx < w and not (dx == 0 and dy == 0)
            )
            if not (0 < n < 8) or rng.random() >= amount:
                continue
            # on retire un pixel de bord, ou on en ajoute un seulement s'il est
            # bien adosse au corps : jamais de pixel flottant
            if grid[y][x]:
                out[y][x] = out[y][w - 1 - x] = 0
            elif n >= 4:
                out[y][x] = out[y][w - 1 - x] = 1
    return out


# --------------------------------------------------------------------------
# A. Blob : la methode purement generative
# --------------------------------------------------------------------------
def largest_component(grid, w, h):
    seen = [[False] * w for _ in range(h)]
    best = []
    for sy in range(h):
        for sx in range(w):
            if grid[sy][sx] and not seen[sy][sx]:
                comp, q = [], deque([(sx, sy)])
                seen[sy][sx] = True
                while q:
                    x, y = q.popleft()
                    comp.append((x, y))
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < w and 0 <= ny < h and grid[ny][nx] and not seen[ny][nx]:
                            seen[ny][nx] = True
                            q.append((nx, ny))
                if len(comp) > len(best):
                    best = comp
    out = [[0] * w for _ in range(h)]
    for x, y in best:
        out[y][x] = 1
    return out


def smooth(grid, w, h, passes=2):
    for _ in range(passes):
        nxt = [[0] * w for _ in range(h)]
        for y in range(h):
            for x in range(w):
                n = sum(
                    grid[y + dy][x + dx]
                    for dy in (-1, 0, 1)
                    for dx in (-1, 0, 1)
                    if 0 <= y + dy < h and 0 <= x + dx < w and not (dx == 0 and dy == 0)
                )
                nxt[y][x] = 1 if (n >= 5 or (grid[y][x] and n >= 3)) else 0
        grid = nxt
    return grid


def blob(size, density, wrel, hrel, rng):
    w = h = size
    half = (w + 1) // 2
    cx, cy = (half - 1) / 2, (h - 1) / 2
    rx, ry = max(1.0, half * wrel), max(1.0, (h / 2) * hrel)
    grid = [[0] * w for _ in range(h)]
    for y in range(h):
        for x in range(half):
            d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2
            if rng.random() < density * (1.25 - d):
                grid[y][x] = grid[y][w - 1 - x] = 1
    return largest_component(smooth(grid, w, h), w, h)


# --------------------------------------------------------------------------
# Rendu commun
# --------------------------------------------------------------------------
def render(grid, w, h, eye=None, eyes=2):
    img = Image.new("LA", (w, h), (0, 0))
    px = img.load()
    for y in range(h):
        for x in range(w):
            if grid[y][x]:
                below = y + 1 >= h or not grid[y + 1][x]
                px[x, y] = (SHADE if (below or y > h * 0.74) else BODY, 255)
    for y in range(h):
        for x in range(w):
            if not grid[y][x] and any(
                0 <= y + dy < h and 0 <= x + dx < w and grid[y + dy][x + dx]
                for dy in (-1, 0, 1)
                for dx in (-1, 0, 1)
            ):
                px[x, y] = (OUTLINE, 255)
    if eye:
        ex, ey = eye
        if 0 <= ex < w and 0 <= ey < h:
            px[ex, ey] = (EYE, 255)
            px[w - 1 - ex, ey] = (EYE, 255)
    elif eyes:
        band = [y for y in range(int(h * 0.2), int(h * 0.55)) if sum(grid[y]) >= 4]
        if band:
            ey = band[len(band) // 2]
            row = [x for x in range(w // 2) if grid[ey][x]]
            if row:
                ex = min(row) + max(1, int((max(row) - min(row)) * 0.45))
                px[ex, ey] = (EYE, 255)
                px[w - 1 - ex, ey] = (EYE, 255)
    return img


def pack(images, cols, cell, path):
    rows = (len(images) + cols - 1) // cols
    sheet = Image.new("LA", (cell * cols, cell * rows), (0, 0))
    for i, im in enumerate(images):
        sheet.paste(
            im,
            ((i % cols) * cell + (cell - im.width) // 2, (i // cols) * cell + (cell - im.height) // 2),
        )
    sheet.save(path)
    return sheet


def preview(sheet, path, scale=5):
    bg = Image.new("RGBA", sheet.size, (12, 16, 22, 255))
    rgba = Image.new("RGBA", sheet.size, (0, 0, 0, 0))
    sp, rp = sheet.load(), rgba.load()
    for y in range(sheet.height):
        for x in range(sheet.width):
            v, a = sp[x, y]
            rp[x, y] = (v, v, v, a)
    bg.alpha_composite(rgba)
    bg.resize((sheet.width * scale, sheet.height * scale), Image.NEAREST).save(path)


BLOB_SET = [
    (12, 0.66, 1.00, 0.85), (12, 0.64, 0.90, 0.95), (14, 0.62, 1.00, 0.70),
    (18, 0.56, 1.00, 0.58), (20, 0.54, 1.00, 0.52), (20, 0.57, 0.92, 0.64),
    (22, 0.56, 0.66, 1.00), (24, 0.58, 0.60, 1.00), (20, 0.64, 0.80, 0.88),
    (22, 0.60, 0.86, 0.82), (26, 0.58, 1.00, 0.86), (26, 0.55, 0.86, 1.00),
]


def main():
    os.makedirs(OUT, exist_ok=True)

    # A. blob
    imgs = []
    for i, (size, dens, wr, hr) in enumerate(BLOB_SET):
        rng = random.Random(1000 + i * 7)
        best = None
        for _ in range(40):
            g = blob(size, dens, wr, hr, rng)
            if sum(map(sum, g)) > size * size * 0.28:
                best = g
                break
            best = best or g
        imgs.append(render(best, size, size))
    s = pack(imgs, 6, 36, os.path.join(OUT, "monsters.png"))
    preview(s, os.path.join(OUT, "monsters_preview.png"))
    print("blob     ", s.size, len(imgs), "sprites")

    # B. familles : 3 variantes par famille, colonne = famille
    imgs, names = [], []
    for v in range(3):
        for name, half in FAMILIES.items():
            grid, w, h, eye = mirror(half)
            rng = random.Random(hash(name) % 9973 + v * 131)
            g = grid if v == 0 else jitter(grid, w, h, 0.05 + 0.04 * v, rng)
            imgs.append(render(g, w, h, eye=eye))
            names.append(f"{name}-{v}")
    s = pack(imgs, len(FAMILIES), 36, os.path.join(OUT, "families.png"))
    preview(s, os.path.join(OUT, "families_preview.png"))
    print("familles ", s.size, len(imgs), "sprites :", ", ".join(FAMILIES))
    print("->", OUT)


if __name__ == "__main__":
    main()
