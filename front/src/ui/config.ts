/**
 * URLs de l'API et de la socket de jeu.
 *
 * Piege connu, herite d'InkPoint (§5 du plan) : Vite **inline** les variables
 * `VITE_*` au moment du `build`, pas au demarrage du conteneur. Si elles ne sont
 * pas passees en `ARG` au `docker build`, le bundle livre retombe sur
 * `localhost` et, sur un site en HTTPS, chaque connexion est bloquee en contenu
 * mixte — le joueur lit « connexion impossible » pour une erreur de deploiement.
 *
 * Le repli ci-dessous est deduit de l'origine courante plutot que code en dur
 * sur `localhost`, ce qui fait que l'oubli degrade au lieu de casser net, et que
 * `wss` suit `https` automatiquement.
 */

export const API_URL = import.meta.env.VITE_API_URL ?? defaultApiUrl();

export function gameSocketUrl(roomCode: string): string {
  const base = import.meta.env.VITE_WS_URL ?? defaultWsUrl();
  return `${base}?room=${encodeURIComponent(roomCode)}`;
}

function defaultApiUrl(): string {
  return import.meta.env.DEV ? 'http://localhost:3000' : window.location.origin;
}

function defaultWsUrl(): string {
  if (import.meta.env.DEV) {
    return 'ws://localhost:3000/ws';
  }
  // https -> wss, jamais ws : une socket en clair depuis une page en HTTPS est
  // bloquee par le navigateur, avec un message peu explicite.
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/ws`;
}
