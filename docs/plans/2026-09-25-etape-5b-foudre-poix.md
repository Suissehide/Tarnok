# Étape 5b — Foudre, Poix, et l'armure : plan d'implémentation

> **Pour les exécutants :** chaque tâche est faite par un sous-agent frais, vérifiée par campagne de
> mutations avant commit. Les étapes sont des cases à cocher.

**But :** deux éléments, une statistique et cinq réactions — **pour zéro octet de plus sur le fil**.

**Architecture :** tout effet de déplacement vit sur une **zone annoncée**, dont les deux côtés
dérivent le même prédicat à partir de positions bit-identiques. Tout effet de dégât vit **côté
serveur seul**, donc échappe entièrement à la contrainte de réplication. La chaîne de la Foudre ne
vit nulle part : elle se **recalcule** des deux côtés à partir du point d'impact.

**Spec :** [`../specs/2026-09-25-etape-5b-foudre-poix.md`](../specs/2026-09-25-etape-5b-foudre-poix.md)

## Contraintes globales

- **Aucun message nouveau, aucun champ ajouté à un message existant.** `ZONE_BYTES = 11`,
  `REACTION_BYTES = 11` et `SNAPSHOT_HEADER_BYTES = 22` ne bougent pas. Un test doit le tenir.
- **Les quatorze tableaux de `Horde` ne gagnent rien.** Les quatre sites à synchroniser
  (`#removeAt`, `spawn`, `saveState`, `restoreState`) ne sont pas touchés.
- **La marque reste cosmétique côté client** (`GameClient#markLocally`). Aucun effet ne roule dessus.
- **Français sans accents dans les commentaires de code** (`deja`, `derive`), avec accents dans les
  documents.
- Commits : minuscules, type dans `build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test`,
  terminés par `Claude-Session: <url de session>`.
- **Vérifier le VERDICT** de `npm run lint`, `npm run typecheck`, `npm test` avant chaque commit.
- **Ne jamais tuer un processus par motif** (`pkill -f`) : les serveurs de dev tournent sur 5173
  et 3100.

## Ce que le code impose et que la spec ne savait pas

**A. `Horde#computeSlow` combine les zones par un MINIMUM, jamais par un produit.** Son docbloc :
*« le minimum est commutatif et associatif exactement ; un produit de flottants ne l'est pas »* —
parce que l'ordre d'itération n'est **pas** garanti identique des deux côtés (`#removeAt` compacte
en échangeant avec le dernier, et le client expire ses zones plus tard que le serveur). Toute
grandeur dérivée d'un recouvrement de zones et **qui voyage** doit se combiner par min ou par max,
jamais par somme ni par produit.

**B. Mais l'amplification de la Poix ne voyage pas.** Le client ne prononce aucun dégât — il reçoit
`DEATHS`. Les effets de dégât échappent donc entièrement à la contrainte A. Ça partage les cinq
réactions en deux familles, et désigne **Verglas** comme la seule réellement risquée.

**C. Le champ laissé par une réaction porte aujourd'hui le SECOND élément, et pour une raison.**
Le docbloc de `ReactionTrigger.element` l'établit : porter celui de la marque laisserait *« le même
tireur redéclencher indéfiniment, avec une seule arme »*. **Ce champ ne doit pas être remplacé par
un type de réaction** — ce serait rompre l'enchaînement coopératif. La tâche 5 le résout en
empaquetant les deux dans le `u8` existant.

## Points de revue

Cinq classes d'entrée que la spec implique et qu'aucune tâche n'exercerait sans ça. Chacune reçoit
son test dans la tâche qui possède le code.

1. **Un ennemi qui meurt de l'impact ne doit pas propager la chaîne** — il ne porte plus rien.
   Même règle que « un ennemi qui meurt du même impact n'est pas marqué ». → tâche 3.
2. **Deux ennemis à distance strictement égale du point d'impact** — l'ordre d'itération tranche,
   et il n'est pas garanti identique. → tâche 2.
3. **Une armure de 1 rendrait l'ennemi immortel**, et un ennemi immortel se lit comme un bug, pas
   comme un réglage. → tâche 1.
4. **Une zone de Poix et une zone de Supraconduction sur le même ennemi** — deux effets dérivés au
   même endroit, l'un de dégât, l'autre de déplacement. → tâche 7.
5. **`ZONE_CAPACITY` saturé** : cinq réactions posent chacune un champ, en plus des champs
   élémentaires. Le compteur `truncatedZones` existe ; il doit rester à zéro en jeu normal et le
   banc doit le dire. → tâche 10.

---

## Tâche 1 : l'armure, et le chemin unique des dégâts

**Fichiers :** modifier `shared/archetypes.ts`, `back/src/combat.ts`, leurs tests

- [ ] **Étape 1 : le champ.** `Archetype.armor`, en fraction de 0 à 1. Zéro pour la piétaille
  légère, > 0 pour les lourds et le boss. **Zéro est une entrée de la table, pas un cas
  particulier** — même motif que `ELEMENT.NEUTRE` et `blastRadius`.

- [ ] **Étape 2 : le test qui échoue d'abord.** Un lourd, une arme, un dégât brut ; l'armure le
  réduit. Puis le test qui compte : **une réduction fractionnaire arrive ENTIÈRE jusqu'aux PV.**

  ```ts
  it('une reduction fractionnaire n est arrondie nulle part', () => {
    // 5 x (1 - 0,3) = 3,5. Horde.hp est un Float32Array et la combustion y
    // retire deja 0,1 par tick : rien n'impose d'entier.
    // 0,3 et 5 ne sont AUCUNE constante de production : une valeur de decor
    // egale a une valeur de production rend la tache invérifiable (GEL_TICKS
    // valait LEVEL_FREEZE_TICKS, 80 tests passaient sur une derivation fausse).
    const horde = hordeAvecUnLourd({ hp: 20, armor: 0.3 });
    appliquerDegats(horde, 0, 5, 1, new Set());
    expect(horde.hp[0]).toBeCloseTo(16.5, 5);
  });
  ```

  ⚠️ **C'est le test de R9**, l'arrondi qui a avalé l'empilement des passifs à l'étape 4 et amplifié
  l'échelle de palier à l'étape 6a. Un `Math.round` glissé dans le chemin le fait rougir.

- [ ] **Étape 3 : la fonction unique.** Dans `back/src/combat.ts` :

  ```ts
  /**
   * **Le seul chemin par lequel un ennemi perd des PV.** Meme raison que
   * `Room#grantCard` pour les cartes : deux formules d'armure divergeraient, et
   * le jour ou elles divergent c'est un test qui manque, pas un bug qui se voit.
   *
   * `amp` est le facteur d'amplification de la Poix (tache 4), 1 sans elle.
   */
  export function appliquerDegats(
    horde: Horde,
    slot: number,
    brut: number,
    amp: number,
    dead: Set<number> | number[],
  ): void
  ```

- [ ] **Étape 4 : router les TROIS sites.** `damageInRadius` (`combat.ts:516`), le tir direct de
  `resolveProjectileDamage` (`combat.ts:685`) et `resolveBurn` (`combat.ts:1030`). **Aucun
  `hp[i] -= …` ne doit subsister** — un `grep -c` le vérifie.

  ⚠️ **`resolveBurn` garde sa borne `<= 0` et son commentaire.** Il y est écrit qu'aucun test ne
  peut la séparer de `< 0`, pour une raison de format de stockage. Ne pas « corriger » ça en
  passant.

- [ ] **Étape 5 : le point de revue n° 3.** Une armure de 1 donnerait des dégâts nuls, donc un
  ennemi immortel — ce qui se lit comme un bug et jamais comme un réglage.

  ```ts
  it('une armure totale ne rend pas un ennemi immortel', () => {
    // Plancher : un coup retire toujours quelque chose.
  });
  ```

  **Plancher proposé : l'armure est bornée à 0,9 dans la table**, donc un coup retire toujours au
  moins un dixième de son brut. Borné à la LECTURE de la table, pas par un `Math.max` au site
  d'application : une borne au site laisserait une valeur aberrante vivre dans la donnée et
  n'échouer que là où personne ne regarde.

- [ ] **Étape 6 : commit** — `feat(shared): les ennemis ont une armure`

---

## Tâche 2 : la Foudre dans la table, et la chaîne déterministe

**Fichiers :** modifier `shared/elements.ts` ; créer `shared/chain.ts` ; leurs tests

- [ ] **Étape 1 : la ligne dans `ELEMENT_DEFS`**, et `ELEMENT.FOUDRE = 3`. `elements.test.ts`
  vérifie déjà que chaque clé pointe sur l'élément du même nom — insérer une ligne sans décaler la
  table fait rougir immédiatement. **Ne pas casser cette garde.**

  `burnPerTick: 0`, `slowFactor: 1` : l'effet de la Foudre n'est ni une brûlure ni un
  ralentissement, c'est une chaîne. La teinte est un choix visuel.

- [ ] **Étape 2 : le test qui échoue d'abord — et c'est LE test de la tâche.**

  ```ts
  it('departage deux ennemis a distance strictement egale par entityId', () => {
    // Deux ennemis symetriques autour du point d'impact : meme distance au
    // BIT pres. L'ordre d'iteration ne peut pas trancher — il depend du
    // compactage de la horde (`#removeAt` echange avec le dernier), qui n'est
    // PAS garanti identique des deux cotes.
    // Un seul saut disponible : la chaine doit choisir le MEME des deux,
    // quel que soit l'ordre dans lequel ils ont ete places.
  });
  ```

  Le poser **deux fois**, avec les deux ordres d'insertion, et exiger le même résultat. Un seul
  ordre passerait avec un tri instable.

- [ ] **Étape 3 : `shared/chain.ts`** — dans `shared/`, parce que **les deux côtés l'appellent** :
  le serveur pour les dégâts, le client pour la polyligne.

  ```ts
  /**
   * Les cibles d'une chaine de Foudre, depuis un point d'impact.
   *
   * ⚠️ **Totalement deterministe, et c'est la raison d'etre du fichier.** Les
   * positions de la horde sont bit-identiques des deux cotes (contrat de
   * l'etape 2, 0,000 px) : la meme entree rend donc la meme sortie, et il n'y
   * a RIEN a annoncer. Mais a une condition — a distance egale, c'est
   * `entityId` qui departage, jamais l'ordre du tableau.
   *
   * ⚠️ **Aucun RNG, meme seme.** Deux cotes qui doivent consommer le meme
   * nombre de tirages au meme moment est une contrainte qui se brise en
   * silence.
   */
  export function chainTargets(
    horde: Horde,
    cx: number,
    cy: number,
    radius: number,
    jumps: number,
    exclude: ReadonlySet<number>,
  ): number[]
  ```

  `exclude` porte les identités déjà touchées — c'est ce qui empêche la chaîne de revenir sur ses
  pas, et c'est aussi le paramètre par lequel la tâche 3 exclut les morts.

- [ ] **Étape 4 : les constantes.** `CHAIN_JUMPS` et `CHAIN_RADIUS` dans `shared/constants.ts`, avec
  le repère en commentaire. **Valeurs de départ, à régler à l'œil** — la spec §10 le dit.

- [ ] **Étape 5 : commit** — `feat(shared): la foudre, et une chaine deterministe`

---

## Tâche 3 : le serveur applique la chaîne, le client la dessine

**Fichiers :** modifier `back/src/combat.ts`, `front/src/render/` (nouveau calque), `front/src/render/frame.ts`, leurs tests

- [ ] **Étape 1 : le serveur.** Dans `resolveProjectileDamage`, un projectile de Foudre qui touche
  appelle `chainTargets` et applique `appliquerDegats` à chaque cible.

- [ ] **Étape 2 : le point de revue n° 1.** Un ennemi qui meurt de l'impact **ne propage pas**.

  ```ts
  it('un ennemi mort du meme impact ne propage pas la chaine', () => {
    // Meme regle que « un ennemi qui meurt du meme impact n'est pas marque »
    // (combat.ts, resolveProjectileDamage) : un mort ne porte plus rien.
  });
  ```

  Le mort passe par `exclude`. ⚠️ **La compaction reste DEHORS**, après tous les dégâts — c'est
  déjà la règle de `damageInRadius`, et la casser ferait sauter des indices en plein parcours.

- [ ] **Étape 3 : le client dessine.** Un calque qui lit la horde et appelle le **même**
  `chainTargets`. La polyligne se dessine entre des positions que le client possède déjà.

  ⚠️ **L'appel passe par `composeFrame`** (`front/src/render/frame.ts`), jamais par la boucle de
  rendu directement. Le tableau en tête de ce fichier dit ce que cette dette a coûté trois fois :
  76, puis 117, puis 170 tests verts au moment de découvrir que l'appel n'était gardé par rien. Un
  test de `frame.test.ts` doit rougir si l'appel est retiré.

- [ ] **Étape 4 : le test qui tient la contrainte globale.**

  ```ts
  it('la chaine n ajoute aucun octet au fil', () => {
    // Un salon ou la Foudre tire, un salon ou elle ne tire pas : meme volume
    // d'octets par tick. C'est le critere de l'etape, pas son espoir.
  });
  ```

- [ ] **Étape 5 : commit** — `feat: la foudre enchaine, et la chaine ne voyage pas`

---

## Tâche 4 : la Poix, et l'amplification dérivée de la zone

**Fichiers :** modifier `shared/elements.ts`, `shared/zones.ts`, `back/src/combat.ts`, leurs tests

- [ ] **Étape 1 : la ligne dans `ELEMENT_DEFS`**, `ELEMENT.POIX = 4`, et un champ
  `damageAmp` sur `Element` (1 : aucune amplification).

  ⚠️ **`slowFactor: 1` — la Poix NE RALENTIT PAS.** C'est l'écart assumé du §3 de la spec : le
  Givre ralentit déjà, et deux ralentissements font du contenu mort. **Écrire la raison dans la
  table**, sinon quelqu'un « corrigera » l'écart au §6.3 dans six mois.

- [ ] **Étape 2 : `ZoneField.ampAt(x, y, tick): number`** — le facteur d'amplification au point
  donné, dérivé de l'appartenance aux zones.

  ```ts
  /**
   * ⚠️ **Un MAXIMUM, jamais une somme.** Deux flaques qui se recouvrent ne
   * doublent pas : elles donnent la plus forte. Ce n'est pas ici une
   * contrainte de replication — le client ne prononce aucun degat — mais une
   * decision de jeu : une amplification qui se somme fait de l'empilement de
   * Poix la seule strategie du jeu.
   *
   * Le MINIMUM de `Horde#computeSlow` a, lui, une raison arithmetique : son
   * docbloc l'explique. Ne pas confondre les deux raisons.
   */
  ampAt(x: number, y: number, tick: number): number
  ```

- [ ] **Étape 3 : le test qui échoue d'abord.**

  ```ts
  it('deux flaques de poix qui se recouvrent ne cumulent pas', () => {
    // Deux zones POIX au meme point, un ennemi dedans : l'amplification vaut
    // celle d'UNE zone, pas leur somme ni leur produit.
  });
  ```

- [ ] **Étape 4 : brancher.** `appliquerDegats` reçoit `amp = zones.ampAt(x, y, tick)` à chacun des
  trois sites. **Un seul endroit calcule, trois endroits consomment.**

- [ ] **Étape 5 : commit** — `feat(shared): la poix amplifie les degats recus`

---

## Tâche 5 : le champ de réaction porte un COUPLE, sans un octet de plus

**Fichiers :** modifier `shared/zones.ts`, `shared/protocol.ts`, `back/src/combat.ts`, leurs tests

- [ ] **Étape 1 : lire d'abord `ReactionTrigger.element`** dans `back/src/combat.ts` (ligne 247 et
  son docbloc). Il établit que le champ laissé au sol porte **le second élément**, et que porter
  celui de la marque laisserait *« le même tireur redéclencher indéfiniment, avec une seule arme »*.

  ⚠️ **Ne PAS remplacer cet élément par un type de réaction.** Ce serait rompre l'enchaînement
  coopératif que la contrainte C protège. Le test qui garde la non-dégénérescence doit **rester
  vert** — si tu le fais rougir, tu as pris le mauvais chemin.

- [ ] **Étape 2 : empaqueter les deux dans le `u8` existant.** Six éléments tiennent sur 3 bits,
  quinze réactions sur 4 :

  ```ts
  /**
   * Ce qu'une zone porte, dans l'octet que `ZONE` avait deja.
   *
   * | bits | contenu | 0 signifie |
   * | --- | --- | --- |
   * | 0-2 | l'element dont la zone MARQUE les ennemis | ne marque rien |
   * | 3-6 | le type de champ de REACTION | aucun effet de reaction |
   *
   * ⚠️ **Zero octet de plus** : `ZONE_BYTES` reste 11. Les deux cotes lisent
   * le meme octet et en derivent les deux sens.
   */
  export function packZoneKind(element: number, reaction: number): number
  export function zoneElement(kind: number): number
  export function zoneReaction(kind: number): number
  ```

- [ ] **Étape 3 : le test qui échoue d'abord** — aller-retour sur les 6 × 16 combinaisons, et
  `ZONE_BYTES === 11` asserté explicitement.

- [ ] **Étape 4 : migrer les lectures.** `Horde#computeSlow` lit `zoneElement(zones.element[z])`,
  `markInZones` aussi. **Chercher toutes les lectures de `zones.element`** — une oubliée teinte
  juste, et ça ne se verra qu'à l'œil.

- [ ] **Étape 5 : commit** — `refactor(shared): une zone porte son element ET sa reaction`

---

## Tâche 6 : les trois réactions de dégât

**Fichiers :** modifier `back/src/combat.ts`, `shared/` (la table des réactions), leurs tests

Surchauffe, Embrasement, Court-circuit. **Aucune ne touche le déplacement**, donc aucune n'est
soumise à la contrainte de réplication.

- [ ] **Étape 1 : la table.** Un effet par couple, piloté par la donnée — même motif que
  `ELEMENT_DEFS`, `WEAPONS` et `ARCHETYPES`. **Pas de `switch` sur la paire.**

- [ ] **Étape 2 : Surchauffe (Braise + Foudre)** — une zone qui brûle plus fort et plus longtemps
  que le champ générique. Le `burnPerTick` du champ vient du type de réaction, pas de l'élément.

- [ ] **Étape 3 : Embrasement (Braise + Poix)** — dégâts à tous les ennemis **poissés** dans un
  rayon.

  ⚠️ **Un rayon, pas une propagation de proche en proche.** C'est l'écart assumé du §5 de la spec :
  un parcours de graphe dépend de son ordre de visite — la même fragilité que la chaîne, en pire.
  Une seule passe, `damageInRadius` filtré sur « poissé ».

- [ ] **Étape 4 : Court-circuit (Foudre + Poix)** — `chainTargets` avec `jumps` non borné, tant que
  les cibles sont poissées. Réutiliser la fonction de la tâche 2, **ne pas en écrire une seconde**.

- [ ] **Étape 5 : le test des deux moitiés.** Assener **quelle** réaction se produit, et qu'une
  paire qui ne devrait rien produire ne produit **rien** — en comparant deux listes champ à champ,
  comme la Synergie à l'étape 5a. *« La barre ne bouge pas » se lit aussi bien « aucune réaction
  n'a eu lieu ».*

- [ ] **Étape 6 : commit** — `feat: surchauffe, embrasement, court-circuit`

---

## Tâche 7 : Supraconduction — vitesse nulle et armure réduite dans la zone

**Fichiers :** modifier `shared/zones.ts`, `shared/horde.ts`, `back/src/combat.ts`, leurs tests

- [ ] **Étape 1 : le gel passe par le MINIMUM existant.** Un champ de Supraconduction a un
  `slowFactor` de 0. `Horde#computeSlow` le prend déjà en charge — **ne pas écrire un second
  mécanisme d'immobilisation.**

  ⚠️ **`slowsAt`, pas `aliveAt`** : une zone posée au tick `T` ne ralentit qu'à partir de `T + 1`,
  parce que le serveur fait avancer la horde AVANT de poser ses zones.

- [ ] **Étape 2 : l'armure réduite est DÉRIVÉE, jamais écrite.**

  ```ts
  /**
   * L'armure effective : celle de l'archetype, moins ce que les champs de
   * Supraconduction lui retirent.
   *
   * ⚠️ **Une fonction, pas un etat.** Un etat ecrit devrait voyager ; une
   * derivation ne le doit pas. Meme forme que `aliveAt` et `slowsAt`.
   */
  export function armureA(horde: Horde, slot: number, zones: ZoneField, tick: number): number
  ```

- [ ] **Étape 3 : le test de réplication — celui qui compte.** Un gel en jeu, avec rejeu, doit
  rendre **0,000 px**. Le décor est écrit : `shared/horde.replication.test.ts` porte déjà les trois
  scénarios et la mesure. **L'étendre, ne pas en écrire une seconde.**

  ⚠️ **Et mesurer aussi SANS rejeu**, pour que le zéro prouve quelque chose. Une mesure qui ne sait
  produire que 0,000 px ne mesure pas — c'est la leçon des deux lignes non nulles du §2 des
  résultats de 6a.

- [ ] **Étape 4 : le point de revue n° 4.** Une zone de Poix et une de Supraconduction sur le même
  ennemi.

  ```ts
  it('un ennemi gele et poisse subit les deux, chacun par son chemin', () => {
    // Le gel passe par #computeSlow (minimum, replique).
    // L'amplification passe par ampAt (maximum, serveur seul).
    // Les deux sur le meme ennemi ne doivent pas s'annuler ni se confondre.
  });
  ```

- [ ] **Étape 5 : commit** — `feat: la supraconduction fige et corrode`

---

## Tâche 8 : Verglas — le dérapage, et un chemin de repli écrit d'avance

**Fichiers :** modifier `shared/horde.ts`, `shared/zones.ts`, leurs tests

⚠️ **C'est la tâche risquée de l'étape.** Le §6.4 dit *« flaque glissante : les ennemis dérapent et
se percutent »*. « Déraper » n'est pas un facteur de vitesse — c'est de l'**inertie**, donc une
modification de l'intégrateur de déplacement, le code le plus protégé du projet.

- [ ] **Étape 1 : la forme retenue.** Dans un champ de Verglas, l'ennemi **conserve sa vitesse
  précédente** au lieu de la recalculer depuis le flowfield, amortie d'un facteur.

  C'est **dérivable des deux côtés** : l'appartenance à la zone est dérivée, et les deux côtés
  possèdent la vitesse précédente parce que les deux simulent. Aucun octet.

- [ ] **Étape 2 : le test de réplication D'ABORD, avant l'implémentation.** Verglas en jeu, avec
  rejeu, 0,000 px — et sans rejeu, un chiffre non nul.

  ⚠️ **Si ce test ne peut pas être vert, ARRÊTER et le dire.** Ne pas « corriger » en rendant
  l'effet autoritaire d'un côté.

- [ ] **Étape 3 : « se percutent » est un dégât, donc serveur seul.** Une collision entre deux
  ennemis qui dérapent inflige des dégâts par `appliquerDegats`. Aucune contrainte de réplication —
  seules les morts voyagent, et elles voyagent déjà.

- [ ] **Étape 4 : le chemin de repli, écrit maintenant.** Si l'inertie diverge : **Verglas devient
  un simple facteur de vitesse > 1 dans la zone**, sans inertie. Ça perd le dérapage mais garde la
  lecture « le sol est glissant », et ça passe par le mécanisme déjà prouvé.

  Le Givre avait un chemin de repli écrit d'avance à l'étape 5a — en faire un pur marqueur — et il
  n'a pas servi. **L'écrire coûte une ligne ; le découvrir en cours de tâche coûte la tâche.**

- [ ] **Étape 5 : commit** — `feat: le verglas fait deraper la horde`

---

## Tâche 9 : les armes qui portent les deux éléments

**Fichiers :** modifier `shared/weapons.ts`, `tools/build_monster_atlas.py` si besoin, leurs tests

- [ ] **Étape 1 : au moins DEUX armes par nouvel élément.** En dessous, l'élément ne se draftera
  qu'accidentellement et l'étape ne se jugera pas. Le pool passe de 9 à ~13.

- [ ] **Étape 2 : chaque arme a une apparence distincte.** `Weapon.look` est obligatoire, et son
  docbloc dit pourquoi : *« neuf armes, neuf apparences »* redeviendrait *« neuf armes, un point
  lumineux »* sans que rien ne le dise.

- [ ] **Étape 3 : `assertWeaponElements` vérifie au CHARGEMENT du module.** Une référence morte ne
  se verrait qu'au premier tir, plusieurs tâches plus tard. La garde existe — ne pas la contourner.

- [ ] **Étape 4 : commit** — `feat(shared): quatre armes pour la foudre et la poix`

---

## Tâche 10 : le banc, peuplé de LOURDS

**Fichiers :** créer `back/bench/elements.bench.ts` ou étendre `zones.bench.ts`

- [ ] **Étape 1 : la porte du §7 de la spec.** Le pas p95 sous 11,11 ms à 4 000 entités, avec quatre
  joueurs portant la Foudre. La chaîne est une recherche de voisinage **par impact**, et la cadence
  a monté de 40 % à l'étape 6a.

- [ ] **Étape 2 : peuplé de LOURDS.** ⚠️ Le banc `zones` a déjà menti une fois — peuplé de piétaille
  légère, il mesurait un monde où presque rien ne survit assez longtemps pour porter une zone. Un
  banc qui rend zéro est le défaut le plus fréquent de ce dépôt (cinq occurrences).

- [ ] **Étape 3 : le point de revue n° 5.** `truncatedZones` doit rester à **zéro** en jeu normal :
  cinq réactions posent chacune un champ, en plus des champs élémentaires, et `ZONE_CAPACITY`
  vaut 128. Si le compteur bouge, ce n'est pas un réglage — c'est la fusion des zones qui ne
  suffit plus.

- [ ] **Étape 4 : l'issue engagée d'avance.** Si le p95 dépasse : la chaîne passe par la **grille de
  voisinage** qui sert déjà à la séparation, pas par un balayage en O(horde).

- [ ] **Étape 5 : commit** — `test(back): le banc des quatre elements`

---

## Tâche 11 : quatre clients, en headless — le livrable

**Fichiers :** créer `back/src/elements-5b.integration.test.ts`

- [ ] **Étape 1 : le harnais existe.** `draft.integration.test.ts`, `elements.integration.test.ts`
  et `portal.integration.test.ts` — quatre vraies sockets, `buildServer({ roomSeed })`, `app.rooms`,
  monstres posés à la main. **Réutiliser, ne pas réinventer.**

- [ ] **Étape 2 : ce que le test doit assener :**
  - quatre joueurs portant quatre éléments différents déclenchent **les six** réactions ;
  - un joueur seul portant deux éléments n'en déclenche **qu'une** ;
  - le trafic par joueur **ne bouge pas** — c'est le critère de l'étape ;
  - les chiffres de réplication restent à **0,000 px**, mesurés là où ils vivent
    (`shared/horde.replication.test.ts`, **pas** dans le test d'intégration : son décor balaie la
    horde par `Horde.kill`, qui court-circuite `DEATHS` — un client qui dériverait sa horde du fil
    divergerait par construction. C'est établi à la tâche 11 de l'étape 6a).

- [ ] **Étape 3 : les deux moitiés.** « Les six réactions se déclenchent » se lit aussi bien avec un
  salon qui déclenche n'importe quoi à tout propos. Assener **quelle** réaction, et qu'une paire
  qui ne devrait rien produire ne produit **rien**.

- [ ] **Étape 4 : commit** — `test(back): quatre elements, six reactions, zero octet de plus`

---

## Tâche 12 : vérification manuelle et clôture

- [ ] **Jouer une run entière.** Ce qui relève du jugement, et que rien n'automatise :
  - la chaîne de Foudre **se voit**-elle, ou disparaît-elle dans la horde ?
  - l'armure **se sent**-elle, ou se lit-elle comme des armes qui ont faibli ?
  - une Poix sans ralentissement **se distingue**-t-elle du Givre en jeu ?
  - une zone de Supraconduction **annule**-t-elle la pression du bullet heaven ?
  - six réactions, est-ce assez pour que le draft ait un sens ?

- [ ] **Rejouer les bancs** — `bench:sim`, `bench:kills`, `bench:niveau2`, et le nouveau.

- [ ] Écrire `docs/plans/2026-09-25-etape-5b-resultats.md`, mettre à jour le `README.md`.

- [ ] **Commit** — `docs: resultats de l'etape 5b`

---

## Auto-relecture

**Couverture de la spec.** §1 le périmètre → tâches 1 à 9 ; §1.1 la non-atteinte à la réplication →
tâches 7 et 8 ; §1.2 le pitch encore faux → rien à faire, c'est un constat ; §2 l'armure → tâche 1 ;
§3 la Poix → tâche 4 ; §4 la Foudre → tâches 2 et 3 ; §5 les cinq réactions → tâches 6, 7 et 8 ;
§6 les armes → tâche 9 ; §7 la porte → tâche 10 ; §8 la vérification → tâches 11 et 12 ; §9 les
écarts → inscrits dans les tâches 4, 6 et 7 ; §10 les questions ouvertes → tâche 12.

**Les deux endroits où ce plan a le plus de chances de se tromper**, nommés plutôt que cachés :

1. **La tâche 5 change un octet déjà en service.** L'empaquetage élément + réaction dans le `u8` de
   `ZONE` est ma proposition, pas celle de la spec — la spec disait « étendre l'espace des
   éléments », ce qui **aurait rompu** l'enchaînement coopératif protégé par le docbloc de
   `ReactionTrigger.element`. Si l'exécutant trouve une troisième voie, qu'il la signale au lieu de
   choisir en silence.

2. **La tâche 8 n'a pas de forme défendable avant d'être essayée.** « Déraper » touche
   l'intégrateur de déplacement, et c'est le seul endroit de cette étape où le contrat de
   réplication est réellement en jeu. Le chemin de repli est écrit ; c'est le seul chiffre de ce
   document qui soit un trou.

**Cohérence des types.** `appliquerDegats(horde, slot, brut, amp, dead)` est définie à la tâche 1 et
consommée aux tâches 3, 6 et 8. `chainTargets(horde, cx, cy, radius, jumps, exclude)` est définie à
la tâche 2 et consommée aux tâches 3 et 6. `ampAt(x, y, tick)` est définie à la tâche 4 ; la tâche 1
déclare le **paramètre** `amp` et lui passe `1` en attendant, la tâche 4 branche la valeur. C'est la
seule dépendance en avant du plan, et elle est volontaire : l'armure doit exister avant que quoi
que ce soit l'amplifie. `armureA(horde, slot, zones, tick)` est définie à la tâche 7 et consommée par
`appliquerDegats`. **`Horde` ne gagne aucun tableau** : la liste des quatorze à tenir à jour dans
`#removeAt` / `spawn` / `saveState` / `restoreState` ne bouge pas.
