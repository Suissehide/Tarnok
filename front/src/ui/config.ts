/**
 * URLs de l'API et de la socket de jeu.
 *
 * ⚠️ Vite **inline** les variables `VITE_*` au `build`, pas au demarrage du
 * conteneur : sans `ARG` au `docker build`, elles manquent au bundle. Le repli
 * est donc deduit de l'origine courante plutot que code en dur sur
 * `localhost` (qui casserait en contenu mixte sous HTTPS) : l'oubli degrade
 * au lieu de casser net, et `wss` suit `https`.
 */

export const API_URL = import.meta.env.VITE_API_URL ?? defaultApiUrl();

/**
 * Racine same-origin du pack Tiny Swords : servie en developpement par le
 * middleware Vite de `vite.config.ts`, en production par le proxy nginx vers
 * MinIO. Jamais une URL de bucket codee en dur.
 */
export const ASSETS_BASE = '/tinyswords';

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
