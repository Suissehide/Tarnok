import { PLAYER_SPEED, TICK_HZ } from '@shared/constants';
import { describe, expect, it } from 'vitest';

import { PredictedPlayer } from './prediction';

const DT = 1 / TICK_HZ;

function advance(player: PredictedPlayer, seconds: number, mx = 0, my = 0): void {
  for (let i = 0; i < Math.round(seconds * TICK_HZ); i++) {
    player.predict(mx, my, DT);
  }
}

describe('PredictedPlayer.predict', () => {
  it('avance immediatement, sans attendre le serveur', () => {
    const player = new PredictedPlayer(0, 0);

    player.predict(1, 0, DT);

    expect(player.renderX).toBeCloseTo((PLAYER_SPEED * 1) / TICK_HZ, 5);
  });

  it('avance a PLAYER_SPEED pixels par seconde', () => {
    const player = new PredictedPlayer(0, 0);

    advance(player, 1, 1, 0);

    expect(player.renderX).toBeCloseTo(PLAYER_SPEED, 0);
  });

  it('ne va pas plus vite en diagonale', () => {
    const straight = new PredictedPlayer(0, 0);
    const diagonal = new PredictedPlayer(0, 0);

    advance(straight, 1, 1, 0);
    advance(diagonal, 1, 1, 1);

    expect(Math.hypot(diagonal.renderX, diagonal.renderY)).toBeCloseTo(straight.renderX, 0);
  });
});

describe('PredictedPlayer.predict — echelle de gel (tache 24)', () => {
  it('une echelle de 0 immobilise le joueur predit ; la meme entree avec une echelle de 1 le deplace', () => {
    const frozen = new PredictedPlayer(0, 0);
    const moving = new PredictedPlayer(0, 0);

    frozen.predict(1, 0, DT, 0);
    moving.predict(1, 0, DT, 1);

    expect(frozen.renderX).toBe(0);
    expect(moving.renderX).toBeGreaterThan(0);
  });

  it('une rampe intermediaire (0.5) avance a la moitie de la vitesse normale', () => {
    const half = new PredictedPlayer(0, 0);
    const full = new PredictedPlayer(0, 0);

    half.predict(1, 0, DT, 0.5);
    full.predict(1, 0, DT, 1);

    expect(half.renderX).toBeCloseTo(full.renderX / 2, 5);
  });

  it("omise, l'echelle vaut 1 par defaut — aucun appelant existant ne se retrouve fige", () => {
    const withoutScale = new PredictedPlayer(0, 0);
    const withScale1 = new PredictedPlayer(0, 0);

    withoutScale.predict(1, 0, DT);
    withScale1.predict(1, 0, DT, 1);

    expect(withoutScale.renderX).toBeCloseTo(withScale1.renderX, 10);
  });
});

describe('PredictedPlayer.reconcile', () => {
  it('ne teleporte pas a l arrivee d une correction serveur', () => {
    const player = new PredictedPlayer(0, 0);

    player.reconcile(200, 0);

    // La position affichee n'a pas bouge d'un coup : c'est tout l'interet.
    expect(player.renderX).toBeCloseTo(0, 5);
  });

  it('resorbe 95 % de l ecart en une centaine de millisecondes', () => {
    const player = new PredictedPlayer(0, 0);
    player.reconcile(200, 0);

    advance(player, 0.1);

    expect(Math.abs(200 - player.renderX)).toBeLessThan(200 * 0.05);
  });

  it('finit par se poser exactement sur la position serveur', () => {
    const player = new PredictedPlayer(0, 0);
    player.reconcile(200, 100);

    advance(player, 0.5);

    expect(player.renderX).toBeCloseTo(200, 2);
    expect(player.renderY).toBeCloseTo(100, 2);
  });

  it("se rapproche a chaque pas au lieu d'osciller", () => {
    const player = new PredictedPlayer(0, 0);
    player.reconcile(200, 0);

    let previous = Math.abs(200 - player.renderX);
    for (let i = 0; i < 10; i++) {
      player.predict(0, 0, DT);
      const error = Math.abs(200 - player.renderX);
      expect(error).toBeLessThan(previous);
      previous = error;
    }
  });

  it('ne bouge rien quand le serveur confirme la prediction', () => {
    const player = new PredictedPlayer(0, 0);
    advance(player, 1, 1, 0);
    const before = player.renderX;

    player.reconcile(player.simX, player.simY);
    player.predict(0, 0, DT);

    expect(player.renderX).toBeCloseTo(before, 5);
  });

  it('continue de repondre aux commandes pendant la correction', () => {
    const player = new PredictedPlayer(0, 0);
    player.reconcile(0, 500);
    const before = player.renderX;

    advance(player, 0.1, 1, 0);

    // La correction porte sur y ; la commande sur x doit passer quand meme.
    expect(player.renderX).toBeGreaterThan(before);
  });
});
