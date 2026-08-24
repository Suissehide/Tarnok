#!/usr/bin/env python3
"""
Construit l'atlas de la pietaille depuis le pack Tiny Swords.

Le §9.2 de la spec de l'etape 2 impose **une seule texture de base** : un
`ParticleContainer` ne batche que si toutes les particules partagent le meme
atlas, et sans batch tout l'interet disparait.

Les planches sources sont des bandes horizontales dont la cellule est carree,
de cote egal a la hauteur : `Gnoll_Walk.png` en 1536x192 fait 8 images de 192.

Toutes les cellules de pietaille faisant 192 de haut, un rangement par etageres
est quasi optimal : dix rangees de 192 dans 2048 offrent 3,93 Mpx utiles, pour
3,06 Mpx a placer.

    python3 tools/build_monster_atlas.py

Sortie : assets/tinyswords/derived/monsters.png et monsters.json
⚠️ Derivee du pack, donc jamais committee. Voir NOTICE-assets.md.
"""

import json
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow manquant : python3 -m pip install Pillow")

ROOT = Path(__file__).resolve().parent.parent
MONSTERS = ROOT / "assets" / "tinyswords" / "Monsters"
OUT_DIR = ROOT / "assets" / "tinyswords" / "derived"

ATLAS_SIZE = 2048

# Doit rester d'accord avec la pietaille de shared/archetypes.ts, dans le meme
# ordre : l'index dans cette liste EST l'identifiant d'archetype.
SHEETS = [
    ("skull", "Skull/Skull_Run.png"),
    ("gnoll", "Gnoll/Gnoll_Walk.png"),
    ("spider", "Spider/Spider_Run.png"),
    ("torch-goblin", "Torch Goblin/Torch Goblin_Run.png"),
    ("lizard", "Lizard/Lizard_Run.png"),
    ("snake", "Snake/Snake_Run.png"),
    ("gnome", "Gnome/Gnome_Run.png"),
    ("slingshot-gnome", "Slingshot Gnome/Slingshot Gnome_Run.png"),
    ("thief", "Thief/Thief_Run.png"),
    ("giant-bat", "Giant Bat/Giant Bat_Move.png"),
    ("bomb-fish", "Bomb Fish/Bomb Fish_Run.png"),
    ("hex-shaman", "Hex Shaman/Hex Shaman_Run.png"),
    ("paddle-shark", "Paddle Shark/Paddle Shark_Run.png"),
    ("harpoon-shark", "Harpoon Shark/Harpoon Shark_Run.png"),
]


def main() -> None:
    if not MONSTERS.is_dir():
        sys.exit(
            f"{MONSTERS} introuvable. Recuperer les assets :\n"
            "  cp deploy/.env.example .env && ./tools/fetch-assets.sh"
        )

    atlas = Image.new("RGBA", (ATLAS_SIZE, ATLAS_SIZE), (0, 0, 0, 0))
    manifest = {"image": "monsters.png", "size": ATLAS_SIZE, "archetypes": []}

    # Rangement par etageres : chaque rangee a la hauteur de sa premiere image.
    x, y, row_height = 0, 0, 0

    for archetype_id, (name, relative) in enumerate(SHEETS):
        path = MONSTERS / relative
        if not path.is_file():
            sys.exit(f"planche manquante : {path}")

        sheet = Image.open(path).convert("RGBA")
        cell = sheet.height
        if sheet.width % cell != 0:
            sys.exit(f"{relative} : largeur {sheet.width} non multiple de {cell}")
        frames = sheet.width // cell

        rects = []
        for f in range(frames):
            if x + cell > ATLAS_SIZE:
                x = 0
                y += row_height
                row_height = 0
            if y + cell > ATLAS_SIZE:
                sys.exit(
                    f"atlas sature a {name} image {f}. "
                    f"Augmenter ATLAS_SIZE ou retirer des archetypes."
                )

            frame = sheet.crop((f * cell, 0, (f + 1) * cell, cell))
            atlas.paste(frame, (x, y))
            rects.append({"x": x, "y": y, "w": cell, "h": cell})

            x += cell
            row_height = max(row_height, cell)

        manifest["archetypes"].append(
            {"id": archetype_id, "name": name, "cell": cell, "frames": frames, "rects": rects}
        )
        print(f"  {name:<18} {frames} images de {cell}px")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    atlas.save(OUT_DIR / "monsters.png")
    (OUT_DIR / "monsters.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")

    used = sum(
        r["w"] * r["h"] for a in manifest["archetypes"] for r in a["rects"]
    )
    print(
        f"\nAtlas ecrit dans {OUT_DIR}\n"
        f"  {len(manifest['archetypes'])} archetypes, "
        f"{used / 1e6:.2f} Mpx utilises sur {ATLAS_SIZE**2 / 1e6:.2f} disponibles"
    )
    print("⚠️ Derive du pack : ne pas committer. Deposer sur MinIO.")


if __name__ == "__main__":
    main()
