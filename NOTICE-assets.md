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
| `docs/maquettes/themes.html` | embarque des sprites du pack en base64 |
| `docs/maquettes/rendu.html` | idem |

### Où vivent les assets

Sur le MinIO du projet, **bucket `tiny-swords`, à la racine**, avec la structure du pack
d'origine préservée (`UI/`, `Units/`, `Monsters/`, `Terrain/`, …). Un objet se trouve donc
à `https://s3.qwetle.fr/tiny-swords/UI/Buttons/Button_Blue_9Slides.png`.

> ⚠️ **L'endpoint S3 n'est pas la console.** `https://minio.qwetle.fr` est l'interface web :
> c'est une application à page unique, donc elle répond `200 text/html` sur **n'importe
> quelle** URL, y compris un objet qui n'existe pas. On croit que ça marche. L'API S3 est
> `https://s3.qwetle.fr`, et elle répond en XML.

```bash
cp deploy/.env.example .env   # renseigner les MINIO_*
./tools/fetch-assets.sh       # -> assets/tinyswords/
```

### Politique de lecture du bucket

nginx sert les assets sous `/tinyswords/` en proxifiant MinIO, et **il ne sait pas signer
une requête S3** (AWS SigV4). Les objets doivent donc être lisibles sans credentials.

La politique ci-dessous autorise `s3:GetObject` et **rien d'autre**. C'est la distinction
qui compte au regard de la licence : le navigateur doit de toute façon télécharger les
images pour afficher le jeu — c'est l'usage normal. En revanche, autoriser `s3:ListBucket`
transformerait le bucket en miroir téléchargeable du pack, et *ça*, c'est de la
redistribution.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": ["*"] },
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::tarnok/*"]
    }
  ]
}
```

```bash
mc alias set qwetle https://s3.qwetle.fr "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY"
mc anonymous set-json politique-tarnok.json qwetle/tarnok
```

Utiliser `set-json` avec la politique ci-dessus plutôt que `mc anonymous set download`, qui
selon les versions accorde aussi le listage.

Vérifier ensuite que les deux comportements sont bien ceux-là :

```bash
curl -sI https://s3.qwetle.fr/tiny-swords/UI/Buttons/Button_Blue_9Slides.png | head -1
#   attendu : HTTP/2 200
curl -s "https://s3.qwetle.fr/tiny-swords?list-type=2" | head -c 80
#   attendu : <Error><Code>AccessDenied</Code>
```

Si une maquette doit un jour être partagée, il faut d'abord en retirer le système de
sprites « Tiny Swords » — les trois autres systèmes (Blob, Familles, Géométrique) sont
générés par `tools/gen_sprites.py` et ne posent aucun problème.

Le *Enemy Pack* payant (~10 $, 18 personnages annoncés vers 30) est soumis à la même
licence.

## Assets générés

Tout ce que produit `tools/gen_sprites.py` — `assets/placeholder/monsters.png`,
`families.png` et leurs aperçus — est du code, pas du dessin. Aucune contrainte, et c'est
ce que les étapes 0 et 1 utilisent : elles ne dessinent que des carrés et des quads.
