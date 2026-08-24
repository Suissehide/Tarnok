# Licences des assets

## Tiny Swords — Pixel Frog

Source : https://pixelfrog-assets.itch.io/tiny-swords

| Point | Terme |
| --- | --- |
| Usage commercial | **autorisé** |
| Crédit | facultatif, « toujours bienvenu » |
| Redistribution | **interdite, même après modification** |

**Ce dépôt est public.** Y pousser le pack — ou n'importe quel fichier qui en dérive —
*est* une redistribution. C'est la contrainte du §12.2 de la spec d'orientation, et elle se
traite au premier commit, jamais après : une fois dans l'historique, retirer ces fichiers
demande une réécriture.

Conséquence concrète : **aucun fichier dérivé du pack n'est versionné.** Sont dans
`.gitignore` :

| Chemin | Nature |
| --- | --- |
| `assets/tinyswords/` | le pack brut, synchronisé depuis MinIO |
| `assets/tinyswords-derived/` | atlas et planches produits par `tools/build_iso_atlas.py` |
| `docs/maquettes/themes.html` | embarque des sprites du pack en base64 |
| `docs/maquettes/rendu.html` | idem |

### Où vivent les assets

Sur le MinIO du projet, bucket `${MINIO_BUCKET}`, sous le préfixe **`tarnok/`**, avec la
structure du pack d'origine préservée (`Units/`, `Monsters/`, `Terrain/`, …). Même
convention que Gachapon.

```bash
cp deploy/.env.example .env   # renseigner les MINIO_*
./tools/fetch-assets.sh       # -> assets/tinyswords/
```

Si une maquette doit un jour être partagée, il faut d'abord en retirer le système de
sprites « Tiny Swords » — les trois autres systèmes (Blob, Familles, Géométrique) sont
générés par `tools/gen_sprites.py` et ne posent aucun problème.

`tools/build_iso_atlas.py` régénère l'atlas depuis le pack : le script, lui, est du code et
peut être publié — c'est sa sortie qui ne peut pas.

Le *Enemy Pack* payant (~10 $, 18 personnages annoncés vers 30) est soumis à la même
licence.

## Assets générés

Tout ce que produit `tools/gen_sprites.py` — `assets/placeholder/monsters.png`,
`families.png` et leurs aperçus — est du code, pas du dessin. Aucune contrainte, et c'est
ce que les étapes 0 et 1 utilisent : elles ne dessinent que des carrés et des quads.
