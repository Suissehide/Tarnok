# Étape 10 — la rareté, et des passifs qui s'empilent : résultats

**Spec :** [`../specs/2026-10-15-etape-10-rarete.md`](../specs/2026-10-15-etape-10-rarete.md)
**Plan :** [`2026-10-15-etape-10-rarete.md`](2026-10-15-etape-10-rarete.md)

Une carte de l'étalage peut sortir **rare (×2)** ou **légendaire (×3)** ; sept passifs arrivent,
dont trois qu'on ne trouve qu'en légendaire. **Zéro octet de plus par tick** : la rareté est un
octet par carte de `DRAFT_OPEN`, une fois par montée de niveau.

⚠️ **Ce document est ouvert.** Le §5 attend la run de l'auteur.

## 1. Le livrable

`back/src/rarete.integration.test.ts` — sur vraies sockets, rareté forcée par
`vi.mock('@shared/rarity')` (seul `rollRarity` est remplacé ; `multiplierOf` et
`applyCardToLoadout` restent les vrais) :

1. la rareté forcée arrive bien sur le fil (`DRAFT_OPEN` décodé, 4 octets par carte) ;
2. la carte rare prise donne **2 exemplaires** dans l'inventaire arbitré par le salon ;
3. le miroir reconstruit à partir des seuls messages décodés (`DRAFT_OPEN` + `DRAFT_RESULT`) tient
   le même inventaire.

Contre-épreuves faites par l'implémenteur : forcer la rareté commune rougit l'étape 1, réduire la
boucle d'application à ×1 rougit l'étape 2.

## 2. Ce qui est livré

| Pièce | Où |
| --- | --- |
| rareté 82 / 15 / 3, ×1 / ×2 / ×3 | `shared/rarity.ts` |
| une rare vaut deux cartes, par le code existant | `applyCardToLoadout` (×n) |
| tirage : rareté de l'emplacement, puis la carte qu'elle permet | `drawSpread` |
| **Précision** (+4 % de critique, plafond 100 %), **Férocité** (+30 % de dégâts critiques) | `critOf` (`shared/firing.ts`), facteur emporté par le projectile |
| **Volée** (+1 cran de salve, armes de tir), **Ampleur** (+1 cran de zone, toutes armes) | `weaponUpgrades` / `armedWeapon` (`shared/firing.ts`) |
| **Colosse** (+1 % de dégâts par 10 PV max) | `shotDamage` (`shared/firing.ts`) |
| **Écho** (+100 % aux dégâts instantanés des réactions que tu déclenches) | `applyReactions` (serveur) |
| **Moisson** (1 PV par mort à moins de 300 px) | `OrbField` + `resolveHarvest` (serveur) |
| bordure grise / bleue / or, reflet à la légendaire, étiquette « Rare ×2 » | `front/src/ui/draft.ts`, `main.css` |

## 3. Écarts au plan et à la spec

- **Une seule formule de tir partagée** (`shared/firing.ts`) remplace les deux copies du serveur et
  du client, avant d'y ajouter Colosse. Sans passif, les valeurs sont identiques au bit près.
- **Le critique du client tirait avec le mauvais tireur** (`by = 0`) : le chiffre doré affiché
  n'était pas celui appliqué par le serveur. Corrigé à la tâche 6, prérequis de Précision.
- **Moisson relève les morts à `OrbField.spawn`** : au moment où `Room.step` assemble ses morts,
  la horde est déjà compactée et les positions perdues. Les huit sites de mort passent tous par là.
- **`BonusKind` se détache de `PassiveKind`** : les sept nouveaux genres ne fuient pas dans la
  boutique ni dans les comptes.
- **Colosse chez un allié, côté client** : le miroir applique les bonus de compte du joueur local à
  tous — même approximation cosmétique que pour les dégâts depuis l'étape 7b.
- **Un incident d'historique** : un sous-agent a amendé le commit de la tâche précédente ; l'histoire
  a été rétablie en deux commits (arbre identique), et la règle « jamais d'amend » ajoutée.
- **Une régression rattrapée** : la tâche 2 avait laissé un test client comparer une carte décodée
  sans `rarity` ; corrigé avant la fin (`d68d802`).
- **Revue finale : trois retouches mineures** (Moisson ignore les joueurs sans la carte, `draftCards`
  typé `Card[]`, libellés accentués des passifs).
- Fait sur la branche `etape-10-rarete`, `main` étant modifié en direct.

## 4. Le portique

Lancé seul, sur `etape-10-rarete` :

| | Résultat |
| --- | --- |
| typecheck (front + back) | vert |
| tests front | 724 passent, **1 échoue** |
| tests back | 1429 passent, **1 échoue**, **1 fichier ne charge pas** |
| lint | 3 erreurs, 3 avertissements |

**Tous ces échecs sont antérieurs à l'étape 10**, identiques à ceux de `main` au départ (constatés
au bilan de l'étape 9) : `draft.test.ts` et `elements-5b` attendent l'arme « Éventail », remplacée
en `5b946c7` ; `elements-5c` expire à 60 s ; Biome signale `icons.test.ts`, `settings.test.ts` et
`shared/random.ts`. Les 3 avertissements CSS datent du 14 octobre.

## 5. Vérification manuelle — ouverte

- la rareté se lit-elle d'un coup d'œil dans l'étalage ?
- 82 / 15 / 3 : les légendaires sont-elles assez rares pour être un événement, assez fréquentes
  pour être vues ?
- Volée à +1 cran par carte commune : jusqu'où l'écran tient-il (lisibilité, budget de
  projectiles) ?
- un build Précision + Férocité devient-il trop dominant ?
- Moisson, Écho, Colosse : se sentent-ils en jeu, ou faut-il un retour visuel ?
- les passifs exclusivement légendaires sont-ils visibles ? (≈ 3 % d'emplacements légendaires × 3
  passifs de poids 1 parmi ~26 cartes : moins de 1,5 % par étalage — à régler via `RARITY_WEIGHTS`
  ou un poids propre si on n'en voit jamais)
- l'étiquette d'Ampleur promet « toutes armes », mais une arme de tir sans rayon n'y gagne rien — à
  reformuler si ça trompe

## 6. Notes de revue laissées pour plus tard

- la somme des PV max est écrite trois fois (`grantCard`, `localMaxHp`, le miroir de tir) — un
  `maxHpFor()` partagé l'unifierait ;
- côté client, le flash du halo et le miroir d'invocation affichent les dégâts de base de l'arme
  (antérieur, cosmétique) ;
- pas de test d'Ampleur au niveau du salon ni du client (couvert par `firing.test.ts`, même chemin
  que Volée) ;
- le facteur de Férocité est stocké en `Float32` (2,3 → 2,2999999), identique des deux côtés ;
- pas de test client vérifiant que les chiffres de dégâts suivent Férocité.
