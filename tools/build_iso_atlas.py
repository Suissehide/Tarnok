"""
Extrait un atlas jouable depuis le pack Tiny Swords.

Prend les lignes d'animation "course" des unites de Factions/Knights/Troops et
Factions/Goblins/Troops, plus quelques elements de Terrain/, et les repacke en
deux feuilles compactes ancrees en bas — c'est l'ancrage qui compte en
isometrique : un sprite se pose par ses pieds, pas par son centre.

Toutes les frames d'une meme unite sont recadrees sur le MEME bbox (l'union de
la ligne), sinon l'ancrage tremble d'une frame a l'autre.

    python3 tools/build_iso_atlas.py [chemin/vers/Tiny Swords]

Ecrit dans assets/tinyswords-derived/ : iso_units.png, iso_decor.png, iso_meta.json

ATTENTION LICENCE : la sortie est une oeuvre derivee de Tiny Swords. Usage
commercial autorise, redistribution interdite meme modifiee. Voir NOTICE-assets.md.
"""

import json
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "assets", "tinyswords-derived")
DEFAULT_PACK = os.path.expanduser("~/Downloads/Tiny Swords")

CELL, NF, DCELL = 56, 6, 104

# (nom, chemin relatif, taille de frame, ligne d'animation)
# ligne 0 = idle, ligne 1 = course, pour toutes ces unites
UNITS = [
    ("warrior_blue",   "Factions/Knights/Troops/Warrior/Blue/Warrior_Blue.png", 192, 1),
    ("warrior_yellow", "Factions/Knights/Troops/Warrior/Yellow/Warrior_Yellow.png", 192, 1),
    ("pawn_blue",      "Factions/Knights/Troops/Pawn/Blue/Pawn_Blue.png", 192, 1),
    ("archer_blue",    "Factions/Knights/Troops/Archer/Blue/Archer_Blue.png", 192, 1),
    ("torch_red",      "Factions/Goblins/Troops/Torch/Red/Torch_Red.png", 192, 1),
    ("torch_purple",   "Factions/Goblins/Troops/Torch/Purple/Torch_Purple.png", 192, 1),
    ("tnt_red",        "Factions/Goblins/Troops/TNT/Red/TNT_Red.png", 192, 1),
    ("barrel_red",     "Factions/Goblins/Troops/Barrel/Red/Barrel_Red.png", 192, 1),
]

DECOR = [
    ("tree",  "Terrain/Resources/Wood/Trees/Tree1.png", 192, 256),
    ("bush1", "Terrain/Decorations/Bushes/Bushe1.png", 128, 128),
    ("bush3", "Terrain/Decorations/Bushes/Bushe3.png", 128, 128),
    ("rock1", "Terrain/Decorations/Rocks/Rock1.png", 64, 64),
    ("rock3", "Terrain/Decorations/Rocks/Rock3.png", 64, 64),
]

# copies telles quelles, utilisees comme tuiles de sol
GROUND = [
    ("Tilemap_Flat.png", "Terrain/Ground/Tilemap_Flat.png"),
    ("Water.png", "Terrain/Water/Water.png"),
]


def union_bbox(frames):
    bb = None
    for f in frames:
        b = f.getbbox()
        if not b:
            continue
        bb = b if bb is None else (min(bb[0], b[0]), min(bb[1], b[1]),
                                   max(bb[2], b[2]), max(bb[3], b[3]))
    return bb


def main(pack):
    if not os.path.isdir(pack):
        sys.exit(f"Pack introuvable : {pack}\nUsage : python3 tools/build_iso_atlas.py <dossier Tiny Swords>")
    os.makedirs(OUT, exist_ok=True)
    meta = {"cell": CELL, "frames": NF, "dcell": DCELL, "units": [], "decor": []}

    sheet = Image.new("RGBA", (CELL * NF, CELL * len(UNITS)), (0, 0, 0, 0))
    for row, (name, rel, fs, anim) in enumerate(UNITS):
        im = Image.open(os.path.join(pack, rel)).convert("RGBA")
        cols = im.width // fs
        frames = [im.crop((c * fs, anim * fs, c * fs + fs, anim * fs + fs))
                  for c in range(min(NF, cols))]
        bb = union_bbox(frames)
        cw, ch = bb[2] - bb[0], bb[3] - bb[1]
        k = min((CELL - 2) / cw, (CELL - 2) / ch)
        nw, nh = max(1, round(cw * k)), max(1, round(ch * k))
        for i, f in enumerate(frames):
            c = f.crop(bb).resize((nw, nh), Image.NEAREST)
            sheet.paste(c, (i * CELL + (CELL - nw) // 2, row * CELL + (CELL - nh)), c)
        meta["units"].append({"name": name, "row": row, "n": len(frames), "w": nw, "h": nh})
        print(f"  {name:16} {len(frames)} frames  {cw}x{ch} -> {nw}x{nh}")
    sheet.save(os.path.join(OUT, "iso_units.png"))

    dsheet = Image.new("RGBA", (DCELL * len(DECOR), DCELL), (0, 0, 0, 0))
    for i, (name, rel, fw, fh) in enumerate(DECOR):
        im = Image.open(os.path.join(pack, rel)).convert("RGBA")
        fr = im.crop((0, 0, fw, fh))
        fr = fr.crop(fr.getbbox())
        k = min((DCELL - 2) / fr.width, (DCELL - 2) / fr.height, 1.0)  # jamais d'agrandissement
        nw, nh = max(1, round(fr.width * k)), max(1, round(fr.height * k))
        fr = fr.resize((nw, nh), Image.NEAREST)
        dsheet.paste(fr, (i * DCELL + (DCELL - nw) // 2, DCELL - nh), fr)
        meta["decor"].append({"name": name, "i": i, "w": nw, "h": nh})
        print(f"  {name:16} -> {nw}x{nh}")
    dsheet.save(os.path.join(OUT, "iso_decor.png"))

    for dest, rel in GROUND:
        Image.open(os.path.join(pack, rel)).save(os.path.join(OUT, dest))
        print(f"  {dest}")

    with open(os.path.join(OUT, "iso_meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
    print("->", OUT)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_PACK)
