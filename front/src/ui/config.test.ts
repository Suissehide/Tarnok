import { describe, expect, it } from 'vitest';

import { gameSocketUrl } from './config';

describe('etape 7a : l URL de jeu ne porte aucun secret', () => {
  /**
   * Le jeton ne passe JAMAIS par une URL — elle atterrit dans les journaux du
   * reverse proxy, dans `Referer` et dans l'historique du navigateur. Ce test
   * epingle la seule chaine de requete admise.
   */
  it('ne contient que le code de salon, et rien d autre', () => {
    const url = new URL(gameSocketUrl('ABCD'));
    expect([...url.searchParams.keys()]).toEqual(['room']);
    expect(url.searchParams.get('room')).toBe('ABCD');
    expect(url.toString()).not.toMatch(/token/i);
  });
});
