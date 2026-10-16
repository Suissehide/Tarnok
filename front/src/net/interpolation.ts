import { INTERP_DELAY_MS } from '@shared/constants';
import type { PlayerSnapshot, SnapshotMessage } from '@shared/protocol';

/**
 * Tampon d'interpolation des entites repliquees.
 *
 * On n'affiche jamais le dernier snapshot recu : on affiche l'etat du monde tel
 * qu'il etait `INTERP_DELAY_MS` plus tot, ce qui garantit d'avoir deux snapshots
 * encadrant l'instant qu'on dessine. Sans ce retard, chaque snapshot en retard
 * ou perdu produit un a-coup, et tout tremble.
 *
 * Le prix est `INTERP_DELAY_MS` (60 ms) de latence visuelle sur les *autres*
 * joueurs. Le sien est predit localement (voir `prediction.ts`), donc le joueur
 * ne sent pas ce retard sur ses propres commandes.
 */

interface Sample {
  tick: number;
  receivedAt: number;
  players: readonly PlayerSnapshot[];
}

/**
 * Profondeur d'historique. A SNAPSHOT_HZ = 30, huit echantillons couvrent
 * environ 267 ms, soit plus de quatre fois le retard d'interpolation : de quoi
 * encaisser une rafale de retard sans laisser l'historique grossir
 * indefiniment.
 */
const MAX_SAMPLES = 8;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class SnapshotBuffer {
  readonly #samples: Sample[] = [];

  get size(): number {
    return this.#samples.length;
  }

  push(snapshot: SnapshotMessage, receivedAt: number): void {
    const newest = this.#samples[this.#samples.length - 1];
    // UDP-like dans l'esprit : un snapshot plus vieux que le dernier connu
    // n'apporte rien et le faire regresser produirait un saut en arriere.
    if (newest && snapshot.tick <= newest.tick) {
      return;
    }

    this.#samples.push({ tick: snapshot.tick, receivedAt, players: snapshot.players });
    if (this.#samples.length > MAX_SAMPLES) {
      this.#samples.shift();
    }
  }

  /**
   * Le snapshot le plus recent, sans interpolation ni retard.
   *
   * Rend aussi `tick` — le tick SERVEUR auquel ces positions ont ete
   * calculees, pas celui du client. C'est ce qui manquait : un appelant qui
   * jette `tick` et reenregistre ce contenu sous sa PROPRE cle de tick locale
   * associe deux ticks qui n'ont aucune raison de coincider. `PlayerHistory`
   * n'a de sens que si les deux cotes indexent sous le meme tick (§5 de la
   * spec de l'etape 2) ; voir `GameClient#advanceHorde`.
   */
  latest(): { tick: number; players: readonly PlayerSnapshot[] } | null {
    const newest = this.#samples[this.#samples.length - 1];
    return newest ? { tick: newest.tick, players: newest.players } : null;
  }

  /** Positions interpolees a l'instant `now`, avec INTERP_DELAY_MS de retard. */
  sample(now: number): PlayerSnapshot[] {
    if (this.#samples.length === 0) {
      return [];
    }

    const renderTime = now - INTERP_DELAY_MS;
    const oldest = this.#samples[0];
    const newest = this.#samples[this.#samples.length - 1];
    if (!oldest || !newest) {
      return [];
    }

    // Pas encore assez d'historique : on s'accroche au plus ancien.
    if (renderTime <= oldest.receivedAt) {
      return oldest.players.map((p) => ({ ...p }));
    }
    // Rien de neuf n'arrive : on fige au dernier connu. Extrapoler ici
    // inventerait des positions, et c'est le sujet de l'etape 2.
    if (renderTime >= newest.receivedAt) {
      return newest.players.map((p) => ({ ...p }));
    }

    let from = oldest;
    let to = newest;
    for (let i = 0; i < this.#samples.length - 1; i++) {
      const a = this.#samples[i];
      const b = this.#samples[i + 1];
      if (a && b && renderTime >= a.receivedAt && renderTime <= b.receivedAt) {
        from = a;
        to = b;
        break;
      }
    }

    const span = to.receivedAt - from.receivedAt;
    const t = span > 0 ? (renderTime - from.receivedAt) / span : 1;

    // On boucle sur le snapshot d'arrivee : un joueur qui vient de partir ne
    // doit pas rester affiche, et un joueur qui vient d'arriver apparait a sa
    // position plutot que de glisser depuis un point qu'il n'a jamais occupe.
    //
    // hp n'est pas interpole : c'est un compteur discret, pas une position
    // continue. On garde celui du snapshot d'arrivee, comme l'id. (xp n'est
    // plus ici : c'est un champ d'equipe, porte par `SnapshotMessage.xp`, pas
    // par `PlayerSnapshot`.) aimX/aimY (tache 13) suivent la meme regle que
    // hp : une direction quantifiee sur un octet n'a rien a gagner a etre
    // interpolee entre deux valeurs deja discretes, et `#fireWeapons` doit de
    // toute facon utiliser la visee du snapshot d'arrivee, pas un melange.
    // pickupRadius (tache 7 de l'etape 7b) suit la meme regle : un rayon
    // achete ne « transitionne » pas visuellement entre deux valeurs, et le
    // ramassage (`DerivedOrbs#capture`) doit comparer celui que le serveur
    // vient d'annoncer, pas un melange qui ferait rater ou mentir une capture.
    // shield (etape 13) suit la meme regle : une reserve n'a rien a gagner a
    // etre interpolee, c'est un compteur discret comme hp.
    return to.players.map((target) => {
      const previous = from.players.find((p) => p.id === target.id);
      if (!previous) {
        return { ...target };
      }
      return {
        id: target.id,
        x: lerp(previous.x, target.x, t),
        y: lerp(previous.y, target.y, t),
        hp: target.hp,
        aimX: target.aimX,
        aimY: target.aimY,
        pickupRadius: target.pickupRadius,
        shield: target.shield,
      };
    });
  }
}
