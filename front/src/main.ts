import { Keyboard } from './input/keyboard';
import { type ConnectionStatus, GameClient } from './net/client';
import { Stage } from './render/stage';
import './styles/main.css';

import { API_URL, gameSocketUrl } from './ui/config';

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`element #${id} absent de index.html`);
  }
  return node as T;
};

const lobby = el('lobby');
const hud = el('hud');
const hudCode = el('hud-code');
const hudStatus = el('hud-status');
const errorLine = el('error');
const codeInput = el<HTMLInputElement>('code');

const keyboard = new Keyboard();
const stage = new Stage();
await stage.init(el('stage'));

el<HTMLButtonElement>('create').addEventListener('click', () => {
  void createRoom();
});
el<HTMLButtonElement>('join').addEventListener('click', () => {
  join(codeInput.value.trim().toUpperCase());
});
codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    join(codeInput.value.trim().toUpperCase());
  }
});

async function createRoom(): Promise<void> {
  errorLine.textContent = '';
  try {
    const res = await fetch(`${API_URL}/rooms`, { method: 'POST' });
    if (!res.ok) {
      throw new Error(`le serveur a repondu ${res.status}`);
    }
    const { code } = (await res.json()) as { code: string };
    join(code);
  } catch (cause) {
    errorLine.textContent = `Impossible de créer le salon : ${(cause as Error).message}`;
  }
}

function join(code: string): void {
  if (!/^[A-Z]{4}$/.test(code)) {
    errorLine.textContent = 'Un code de salon fait quatre lettres.';
    return;
  }

  const client = new GameClient(gameSocketUrl(code), () => keyboard.axes(), onStatus);
  client.connect();

  lobby.classList.add('hidden');
  hud.classList.remove('hidden');
  hud.classList.add('flex');
  hudCode.textContent = code;

  stage.run((now, dt) => {
    const state = client.update(now, dt);
    stage.drawHorde(client.horde, now);
    return state;
  });

  // Poignee de debogage, en developpement seulement.
  //
  // Le ticker Pixi passe par `requestAnimationFrame`, suspendu dans un onglet en
  // arriere-plan : impossible d'y verifier quoi que ce soit sans pouvoir avancer
  // les images a la main. C'est ce qui a produit un faux bug de replication a
  // l'etape 0 — une capture d'ecran d'un onglet cache montre une image perimee.
  //
  // Utile au-dela des tests : le §4.6 de l'orientation demande un HUD de debug
  // plutot que des logs.
  if (import.meta.env.DEV) {
    (window as unknown as { __tarnok?: unknown }).__tarnok = {
      client,
      stage,
      /** Avance et dessine `count` images, sans dependre de rAF. */
      step(count = 1, dt = 1 / 60): void {
        for (let i = 0; i < count; i++) {
          const state = client.update(performance.now(), dt);
          stage.drawHorde(client.horde, performance.now());
          stage.draw(state);
        }
      },
    };
  }
}

function onStatus(status: ConnectionStatus): void {
  const label: Record<ConnectionStatus, string> = {
    connecting: 'connexion…',
    open: 'connecté',
    // Le serveur coupé fige les carrés : c'est la preuve que l'autorite est
    // serveur et pas locale, pas un bug a masquer.
    closed: 'serveur injoignable — les carrés se figent',
  };
  hudStatus.textContent = label[status];
}
