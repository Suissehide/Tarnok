import { INTERP_DELAY_MS, PLAYER_MAX_HP } from '@shared/constants';
import { MSG, type SnapshotMessage } from '@shared/protocol';
import { describe, expect, it } from 'vitest';

import { SnapshotBuffer } from './interpolation';

/**
 * hp n'est pas le sujet de ces tests (l'interpolation de position l'est) : on
 * lui donne une valeur par defaut plutot que de l'imposer a chaque appel. xp
 * n'existe plus par joueur (c'est un champ d'equipe, sur `SnapshotMessage`) :
 * on le fixe a 0 par defaut, sauf pour les tests qui le portent explicitement.
 * Meme regle pour aimX/aimY (tache 13) : `(0, 0)`, « pas de tir », sauf pour
 * le test qui porte specifiquement sur la visee.
 */
function snapshot(
  tick: number,
  players: { id: number; x: number; y: number; hp?: number; aimX?: number; aimY?: number }[],
  xp = 0,
  synergy = 0,
): SnapshotMessage {
  return {
    type: MSG.SNAPSHOT,
    tick,
    xp,
    synergy,
    players: players.map((p) => ({ hp: PLAYER_MAX_HP, aimX: 0, aimY: 0, ...p })),
    // Ce decor n'interpole que des JOUEURS : le boss de la tache 4 (etape 6a)
    // ne passe pas par `SnapshotBuffer` — il n'a pas de position sur le fil,
    // seulement une vie. `null` est donc l'etat reel, pas un remplissage.
    boss: null,
  };
}

describe('SnapshotBuffer.sample', () => {
  it('rend la position a mi-chemin entre deux snapshots', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot(1, [{ id: 1, x: 0, y: 100 }]), 0);
    buffer.push(snapshot(2, [{ id: 1, x: 100, y: 200 }]), 50);

    // On affiche toujours INTERP_DELAY_MS en arriere : a `now`, le temps de
    // rendu vaut 25 ms, soit pile entre les deux snapshots.
    const sampled = buffer.sample(INTERP_DELAY_MS + 25);

    expect(sampled).toEqual([{ id: 1, x: 50, y: 150, hp: PLAYER_MAX_HP, aimX: 0, aimY: 0 }]);
  });

  it('porte la visee du snapshot d arrivee, sans l interpoler (tache 13)', () => {
    // ⚠️ Meme raisonnement que le test des pv juste au-dessus : la mutation
    // qui remplacerait `target.aimX`/`aimY` par `previous.aimX`/`aimY` (ou par
    // une moyenne) doit faire echouer ce test. On choisit donc deux valeurs
    // qui DIFFERENT visiblement entre les deux snapshots, jamais deux valeurs
    // qui coincideraient par accident.
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot(1, [{ id: 1, x: 0, y: 0, aimX: 40, aimY: -20 }]), 0);
    buffer.push(snapshot(2, [{ id: 1, x: 100, y: 0, aimX: -90, aimY: 60 }]), 50);

    const sampled = buffer.sample(INTERP_DELAY_MS + 25);

    expect(sampled[0]).toMatchObject({ aimX: -90, aimY: 60 });
  });

  it('porte les pv du snapshot d arrivee, sans les interpoler', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot(1, [{ id: 1, x: 0, y: 0, hp: 80 }]), 0);
    buffer.push(snapshot(2, [{ id: 1, x: 100, y: 0, hp: 55 }]), 50);

    // Position a mi-chemin (voir le premier test), mais hp n'est pas une
    // position : c'est un compteur discret, on prend celui du snapshot
    // d'arrivee tel quel.
    const sampled = buffer.sample(INTERP_DELAY_MS + 25);

    expect(sampled[0]).toMatchObject({ hp: 55 });
  });

  it('rend un quart du chemin au quart du temps', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot(1, [{ id: 1, x: 0, y: 0 }]), 0);
    buffer.push(snapshot(2, [{ id: 1, x: 400, y: 0 }]), 100);

    expect(buffer.sample(INTERP_DELAY_MS + 25)[0]?.x).toBe(100);
  });

  it("s'accroche au plus ancien snapshot tant que le retard n'est pas absorbe", () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot(1, [{ id: 1, x: 10, y: 20 }]), 0);
    buffer.push(snapshot(2, [{ id: 1, x: 999, y: 999 }]), 50);

    // Temps de rendu negatif : on n'a pas encore de quoi interpoler.
    expect(buffer.sample(0)).toEqual([
      { id: 1, x: 10, y: 20, hp: PLAYER_MAX_HP, aimX: 0, aimY: 0 },
    ]);
  });

  it('ne va pas plus loin que le dernier snapshot recu', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot(1, [{ id: 1, x: 0, y: 0 }]), 0);
    buffer.push(snapshot(2, [{ id: 1, x: 100, y: 0 }]), 50);

    // Une seconde plus tard, rien de neuf n'est arrive. On fige au dernier
    // connu plutot que d'extrapoler : l'extrapolation appartient a l'etape 2.
    expect(buffer.sample(1000)[0]?.x).toBe(100);
  });

  it('rend un tableau vide tant qu aucun snapshot n est arrive', () => {
    expect(new SnapshotBuffer().sample(500)).toEqual([]);
  });

  it("montre a sa position d'arrivee un joueur absent du snapshot precedent", () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot(1, [{ id: 1, x: 0, y: 0 }]), 0);
    buffer.push(
      snapshot(2, [
        { id: 1, x: 100, y: 0 },
        { id: 2, x: 500, y: 500 },
      ]),
      50,
    );

    const sampled = buffer.sample(INTERP_DELAY_MS + 25);

    expect(sampled.find((p) => p.id === 2)).toEqual({
      id: 2,
      x: 500,
      y: 500,
      hp: PLAYER_MAX_HP,
      aimX: 0,
      aimY: 0,
    });
  });

  it('fait disparaitre un joueur absent du snapshot le plus recent', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(
      snapshot(1, [
        { id: 1, x: 0, y: 0 },
        { id: 2, x: 500, y: 500 },
      ]),
      0,
    );
    buffer.push(snapshot(2, [{ id: 1, x: 100, y: 0 }]), 50);

    const sampled = buffer.sample(INTERP_DELAY_MS + 50);

    expect(sampled.map((p) => p.id)).toEqual([1]);
  });
});

describe('SnapshotBuffer.latest', () => {
  it('rend le dernier snapshot recu, sans retard', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot(1, [{ id: 1, x: 0, y: 0 }]), 0);
    buffer.push(snapshot(2, [{ id: 1, x: 100, y: 0 }]), 50);

    expect(buffer.latest()?.players[0]?.x).toBe(100);
  });

  it('rend le tick SERVEUR du dernier snapshot, pas un compteur local', () => {
    // C'est la piece qui manquait (constat C1) : sans le tick, l'appelant ne
    // peut qu'enregistrer ce contenu sous sa propre cle de tick, qui n'a
    // aucune raison de coincider avec celle du serveur.
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot(1, [{ id: 1, x: 0, y: 0 }]), 0);
    buffer.push(snapshot(7, [{ id: 1, x: 100, y: 0 }]), 50);

    expect(buffer.latest()?.tick).toBe(7);
  });

  it('rend null quand rien n est arrive', () => {
    expect(new SnapshotBuffer().latest()).toBeNull();
  });
});

describe('SnapshotBuffer.push', () => {
  it('ignore un snapshot arrive dans le desordre', () => {
    const buffer = new SnapshotBuffer();
    buffer.push(snapshot(5, [{ id: 1, x: 100, y: 0 }]), 100);
    buffer.push(snapshot(3, [{ id: 1, x: 0, y: 0 }]), 110);

    // Le vieux snapshot n'a pas remplace le recent.
    expect(buffer.sample(10_000)[0]?.x).toBe(100);
  });

  it('ne garde pas un historique sans fin', () => {
    const buffer = new SnapshotBuffer();
    for (let tick = 1; tick <= 1000; tick++) {
      buffer.push(snapshot(tick, [{ id: 1, x: tick, y: 0 }]), tick * 50);
    }

    expect(buffer.size).toBeLessThanOrEqual(8);
  });
});
