#!/usr/bin/env python3
"""
Construit l'atlas de la pietaille depuis le pack Tiny Swords.

Le §9.2 de la spec de l'etape 2 impose **une seule texture de base** : un
`ParticleContainer` ne batche que si toutes les particules partagent le meme
atlas, et sans batch tout l'interet disparait.

Les planches sources sont des bandes horizontales dont la cellule est carree,
de cote egal a la hauteur : `Gnoll_Walk.png` en 1536x192 fait 8 images de 192.

Tache 17.2 : l'atlas embarque desormais DEUX planches par archetype — course
et attaque — plutot que la seule course. Un monstre a portee de contact
s'arrete et joue son clip d'attaque (`shared/horde.ts` decide l'arret,
`front/src/render/horde-renderer.ts` choisit le clip). Consequence mecanique :
~189 images a ranger au lieu de 83, ce qui ne tient plus dans les 3,93 Mpx
utiles d'un atlas de 2048 (dix rangees de 192) — d'ou `ATLAS_SIZE = 4096`
(9 rangees de 192 suffisent, tres large marge).

⚠️ Toutes les planches de pietaille n'ont pas de fichier `..._Attack.png` :
quatre archetypes du pack (gnoll, slingshot-gnome, bomb-fish, harpoon-shark)
sont a distance et n'ont qu'un `..._Throw.png` ou `..._Shoot.png` — pas de
`..._Attack.png` du tout. C'est l'equivalent fonctionnel (l'animation jouee a
l'arret, au contact) : `SOURCES` la reference explicitement plutot que de
deviner un nom de fichier a l'execution. Voir le rapport de la tache 17.

Tache 17.1 : le manifeste publie aussi, par archetype, la boite englobante du
contenu NON TRANSPARENT — union sur toutes les images des DEUX clips, pour une
echelle qui ne varie pas d'une image d'animation a l'autre. C'est elle, pas la
cellule, que `front/src/render/horde-renderer.ts` doit mettre a l'echelle de
`PROJECTILE_HIT_RADIUS` : une cellule de 192 px est en grande partie vide, la
creature n'en occupe qu'une fraction.

Tache 5 de l'etape 6a : **le BOSS entre dans l'atlas**. Il etait simule, touche,
marque et tue depuis la tache 3, mais pas dessine — `SOURCES` ne listait que les
quatorze pietailles, et `HordeRenderer.draw` saute silencieusement un archetype
sans textures. Le troll (`BOSS_NAME`, `shared/archetypes.ts`) est l'archetype
19, donc six creneaux apres la derniere pietaille : `SOURCES` porte desormais
des TROUS explicites (`None`) pour que son index reste son identifiant.

⚠️ **Les cinq autres elites restent des trous, et c'est une MESURE, pas un
oubli.** Empaqueter les six elites du bestiaire sature l'atlas : leurs cellules
font 256 a 384 px et leurs clips d'attaque sont longs (jusqu'a 13 images pour le
panda), soit 9,2 Mpx a ajouter aux 7,0 Mpx de la pietaille — 16,2 Mpx de contenu
pour 16,8 Mpx d'atlas, que le rangement par etageres ne sait pas placer sans
perte. Verifie en simulant l'empaquetage : SATURE a six elites, 9,33 Mpx sur
16,78 avec le seul troll. Les cinq autres n'apparaissent jamais en jeu (le
generateur ne tire que dans la pietaille), donc les ranger serait payer un
depassement pour un contenu que personne ne voit. Le jour ou l'etape 6b leur
donnera un pool tournant, c'est `ATLAS_SIZE` — ou un second atlas — qu'il faudra
rouvrir, pas cette liste.

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

ATLAS_SIZE = 4096

# Doit rester d'accord avec `ARCHETYPES` de shared/archetypes.ts, dans le meme
# ordre : l'index dans cette liste EST l'identifiant d'archetype.
#
# ⚠️ **Un `None` est un archetype QUI N'ENTRE PAS DANS L'ATLAS**, pas une case
# qu'on aurait oublie de remplir. C'est ce qui permet de ranger le boss
# (archetype 19) sans ranger les cinq elites qui le precedent — voir la note du
# module — tout en gardant l'invariant « index == identifiant », qui est la
# convention de tout `shared/`. Le manifeste, lui, ne publie que les archetypes
# reellement ranges, chacun avec son `id` explicite : c'est ce champ, et pas la
# position dans le tableau, que `HordeRenderer.adoptAtlas` lit.
#
# Troisieme colonne : la planche d'attaque. `_Attack.png` quand le pack en a
# une ; sinon le clip d'action a distance du pack (`_Throw.png`/`_Shoot.png`)
# — voir la note du module ci-dessus, ces quatre-la n'ont pas de `_Attack.png`.
SOURCES = [
    ("skull", "Skull/Skull_Run.png", "Skull/Skull_Attack.png"),
    ("gnoll", "Gnoll/Gnoll_Walk.png", "Gnoll/Gnoll_Throw.png"),
    ("spider", "Spider/Spider_Run.png", "Spider/Spider_Attack.png"),
    (
        "torch-goblin",
        "Torch Goblin/Torch Goblin_Run.png",
        "Torch Goblin/Torch Goblin_Attack.png",
    ),
    ("lizard", "Lizard/Lizard_Run.png", "Lizard/Lizard_Attack.png"),
    ("snake", "Snake/Snake_Run.png", "Snake/Snake_Attack.png"),
    ("gnome", "Gnome/Gnome_Run.png", "Gnome/Gnome_Attack.png"),
    (
        "slingshot-gnome",
        "Slingshot Gnome/Slingshot Gnome_Run.png",
        "Slingshot Gnome/Slingshot Gnome_Shoot.png",
    ),
    ("thief", "Thief/Thief_Run.png", "Thief/Thief_Attack.png"),
    ("giant-bat", "Giant Bat/Giant Bat_Move.png", "Giant Bat/Giant Bat_Attack.png"),
    ("bomb-fish", "Bomb Fish/Bomb Fish_Run.png", "Bomb Fish/Bomb Fish_Shoot.png"),
    ("hex-shaman", "Hex Shaman/Hex Shaman_Run.png", "Hex Shaman/Hex Shaman_Attack.png"),
    (
        "paddle-shark",
        "Paddle Shark/Paddle Shark_Run.png",
        "Paddle Shark/Paddle Shark_Attack.png",
    ),
    (
        "harpoon-shark",
        "Harpoon Shark/Harpoon Shark_Run.png",
        "Harpoon Shark/Harpoon Shark_Throw.png",
    ),
    # --- Elites (ARCHETYPES 14 a 19) : seul le boss est range. Voir ci-dessus.
    None,  # 14 spear-goblin
    None,  # 15 bear
    None,  # 16 panda
    None,  # 17 turtle
    None,  # 18 minotaur
    ("troll", "Troll/Troll_Walk.png", "Troll/Troll_Attack.png"),  # 19 — BOSS_NAME
]


class Shelf:
    """
    L'etat mutable du rangement par etageres, partage par TOUS les
    archetypes et leurs deux clips — c'est ce qui rend l'empaquetage
    quasi optimal (voir le docstring du module) : rien ne force un
    archetype ou un clip a commencer une nouvelle rangee.
    """

    def __init__(self) -> None:
        self.x = 0
        self.y = 0
        self.row_height = 0

    def place(self, cell: int, name: str, frame_index: int) -> tuple[int, int]:
        if self.x + cell > ATLAS_SIZE:
            self.x = 0
            self.y += self.row_height
            self.row_height = 0
        if self.y + cell > ATLAS_SIZE:
            sys.exit(
                f"atlas sature a {name} image {frame_index}. "
                f"Augmenter ATLAS_SIZE ou retirer des archetypes."
            )
        placed = (self.x, self.y)
        self.x += cell
        self.row_height = max(self.row_height, cell)
        return placed


def load_sheet(path: Path) -> Image.Image:
    if not path.is_file():
        sys.exit(f"planche manquante : {path}")
    sheet = Image.open(path).convert("RGBA")
    if sheet.height == 0:
        sys.exit(f"{path} : hauteur nulle, planche invalide")
    if sheet.width % sheet.height != 0:
        sys.exit(f"{path} : largeur {sheet.width} non multiple de {sheet.height}")
    return sheet


def frame_bbox(frame: Image.Image) -> tuple[int, int, int, int] | None:
    """
    Boite englobante du contenu non transparent d'UNE image, dans le repere de
    la cellule (pas de l'atlas). `None` si l'image est entierement transparente.

    Passe explicitement par le canal alpha plutot que par
    `Image.getbbox(alpha_only=True)` : ce parametre n'existe que depuis
    Pillow 9.2, et `split()[-1].getbbox()` donne la meme reponse sur toute
    version installee.
    """
    return frame.split()[-1].getbbox()


def pack_clip(
    atlas: Image.Image,
    shelf: Shelf,
    sheet: Image.Image,
    name: str,
) -> tuple[dict, tuple[int, int, int, int] | None]:
    """
    Range toutes les images d'UNE planche (un clip) sur les etageres
    partagees, colle chaque image dans `atlas`, et rend :
    - le clip du manifeste (`frames`, `rects`) ;
    - la boite englobante UNION de ses propres images (repere cellule),
      ou `None` si le clip entier est transparent.
    """
    cell = sheet.height
    frames = sheet.width // cell
    rects = []
    union: tuple[int, int, int, int] | None = None

    for f in range(frames):
        frame = sheet.crop((f * cell, 0, (f + 1) * cell, cell))
        x, y = shelf.place(cell, name, f)
        atlas.paste(frame, (x, y))
        rects.append({"x": x, "y": y, "w": cell, "h": cell})

        bbox = frame_bbox(frame)
        if bbox is not None:
            if union is None:
                union = bbox
            else:
                union = (
                    min(union[0], bbox[0]),
                    min(union[1], bbox[1]),
                    max(union[2], bbox[2]),
                    max(union[3], bbox[3]),
                )

    return {"frames": frames, "rects": rects}, union


def main() -> None:
    if not MONSTERS.is_dir():
        sys.exit(
            f"{MONSTERS} introuvable. Recuperer les assets :\n"
            "  cp deploy/.env.example .env && ./tools/fetch-assets.sh"
        )

    atlas = Image.new("RGBA", (ATLAS_SIZE, ATLAS_SIZE), (0, 0, 0, 0))
    manifest = {"image": "monsters.png", "size": ATLAS_SIZE, "archetypes": []}
    shelf = Shelf()

    for archetype_id, source in enumerate(SOURCES):
        # Un trou : cet archetype existe dans `ARCHETYPES` mais n'entre pas dans
        # l'atlas. Rien n'est range, et le manifeste ne le mentionne pas — c'est
        # `HordeRenderer.draw` qui saute alors silencieusement les entites de cet
        # archetype, comme il le faisait pour les vingt elites avant cette tache.
        if source is None:
            continue
        name, run_relative, attack_relative = source
        run_sheet = load_sheet(MONSTERS / run_relative)
        attack_sheet = load_sheet(MONSTERS / attack_relative)
        if run_sheet.height != attack_sheet.height:
            sys.exit(
                f"{name} : cellule de course ({run_sheet.height}px) et "
                f"d'attaque ({attack_sheet.height}px) different — les deux "
                "clips d'un meme archetype doivent partager leur cellule."
            )
        cell = run_sheet.height

        run_clip, run_bbox = pack_clip(atlas, shelf, run_sheet, f"{name} (course)")
        attack_clip, attack_bbox = pack_clip(atlas, shelf, attack_sheet, f"{name} (attaque)")

        # Boite englobante du CONTENU (tache 17.1), union des deux clips :
        # une echelle unique par archetype, qui ne varie pas entre la course
        # et l'attaque ni d'une image a l'autre du meme cycle.
        boxes = [b for b in (run_bbox, attack_bbox) if b is not None]
        if not boxes:
            # Planche entierement transparente : ne devrait jamais arriver
            # sur de vraies planches Tiny Swords. Repli sur la cellule
            # entiere plutot que planter — mieux vaut un monstre a la bonne
            # taille de cadre qu'un build casse.
            bounds = {"x": 0, "y": 0, "w": cell, "h": cell}
        else:
            bx0 = min(b[0] for b in boxes)
            by0 = min(b[1] for b in boxes)
            bx1 = max(b[2] for b in boxes)
            by1 = max(b[3] for b in boxes)
            bounds = {"x": bx0, "y": by0, "w": bx1 - bx0, "h": by1 - by0}

        manifest["archetypes"].append(
            {
                "id": archetype_id,
                "name": name,
                "cell": cell,
                "bounds": bounds,
                "clips": {"run": run_clip, "attack": attack_clip},
            }
        )
        print(
            f"  {name:<18} course {run_clip['frames']} images, "
            f"attaque {attack_clip['frames']} images, "
            f"contenu {bounds['w']}x{bounds['h']}px (cellule {cell}px)"
        )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    atlas.save(OUT_DIR / "monsters.png")
    (OUT_DIR / "monsters.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")

    used = sum(
        r["w"] * r["h"]
        for a in manifest["archetypes"]
        for clip in a["clips"].values()
        for r in clip["rects"]
    )
    print(
        f"\nAtlas ecrit dans {OUT_DIR}\n"
        f"  {len(manifest['archetypes'])} archetypes, "
        f"{used / 1e6:.2f} Mpx utilises sur {ATLAS_SIZE**2 / 1e6:.2f} disponibles"
    )
    print("⚠️ Derive du pack : ne pas committer. Deposer sur MinIO.")


if __name__ == "__main__":
    main()
