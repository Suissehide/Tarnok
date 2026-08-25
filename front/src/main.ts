import { Keyboard } from './input/keyboard';
import { Mouse } from './input/mouse';
import {
  type ConnectionStatus,
  GameClient,
  type InputAxes,
  type RenderState,
  type RunOverSummary,
} from './net/client';
import { formatSummary, hudInfo, Stage } from './render/stage';
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
const hudHp = el('hud-hp');
const hudLevel = el('hud-level');
const hudTimer = el('hud-timer');
const hudLateDeaths = el('hud-late-deaths');
const summary = el('summary');
const summaryTime = el('summary-time');
const summaryLevel = el('summary-level');
const summaryKills = el('summary-kills');
const errorLine = el('error');
const codeInput = el<HTMLInputElement>('code');

const keyboard = new Keyboard();
const stage = new Stage();
await stage.init(el('stage'));
// La souris s'ecoute sur le canevas du jeu, cree par `stage.init` juste
// au-dessus : c'est lui qui sert de reference pour les coordonnees ecran
// (tache 13), et `Stage.screenToWorld` partage la meme camera.
const mouse = new Mouse(stage.canvas);

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

  const client = new GameClient(
    gameSocketUrl(code),
    () => keyboard.axes(),
    onStatus,
    showSummary,
    readAim,
  );
  client.connect();

  lobby.classList.add('hidden');
  hud.classList.remove('hidden');
  hud.classList.add('flex');
  hudCode.textContent = code;

  /**
   * Direction visee (tache 13) : position du curseur en monde, moins celle du
   * joueur local, normalisee. `(0, 0)` — nulle plutot qu'une direction par
   * defaut — tant que la souris n'a jamais bouge, ou que le joueur local
   * n'existe pas encore (avant le premier snapshot qui le fait apparaitre) :
   * les deux sont deja « pas de tir » pour `GameClient` (voir sa doc).
   *
   * Le curseur vit en coordonnees ECRAN ; `stage.screenToWorld` fait la
   * conversion avec la MEME camera que celle qui dessine `client`, sinon la
   * visee deriverait des que la camera bouge.
   */
  function readAim(): InputAxes {
    const screen = mouse.screenPosition();
    const local = client.localPosition;
    if (!screen || !local) {
      return { x: 0, y: 0 };
    }
    const world = stage.screenToWorld(screen.x, screen.y);
    const dx = world.x - local.x;
    const dy = world.y - local.y;
    const len = Math.hypot(dx, dy);
    return len === 0 ? { x: 0, y: 0 } : { x: dx / len, y: dy / len };
  }

  /**
   * Une image complete : avance le client, dessine chaque calque, met a jour
   * le HUD (§4.6 — un HUD, pas des logs). Factorise entre le ticker Pixi
   * (`stage.run`, qui appelle lui-meme `stage.draw`) et la poignee de
   * debogage `step()` ci-dessous, qui doit `draw` explicitement puisqu'elle
   * n'emprunte pas le ticker.
   */
  function renderFrame(now: number, dt: number): RenderState {
    const state = client.update(now, dt);
    stage.drawHorde(client.horde, now);
    stage.drawOrbs(client.orbs, now);
    stage.drawProjectiles(client.projectiles);
    stage.drawImpactFlashes(client.hitFlashes, now);
    updateHud(state, client);
    return state;
  }

  stage.run(renderFrame);

  el<HTMLButtonElement>('summary-restart').addEventListener('click', () => {
    client.disconnect();
    // Reinitialisation la plus sure : `Stage`/`Keyboard` ne sont pas concus
    // pour etre demontes puis reutilises, et un salon termine n'a de toute
    // facon plus rien a offrir que revenir au lobby.
    window.location.reload();
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
      /**
       * Avance et dessine `count` images, sans dependre de rAF.
       *
       * Rend aussi a chaque image : `draw` / `drawHorde` ne font que mettre a
       * jour la scene en memoire, c'est le ticker Pixi (rAF, donc suspendu
       * hors focus) qui la peint d'ordinaire. Sans ce rendu force, `step`
       * avancerait la simulation sans que le canevas ne le montre jamais.
       */
      step(count = 1, dt = 1 / 60): void {
        for (let i = 0; i < count; i++) {
          const state = renderFrame(performance.now(), dt);
          stage.draw(state);
          stage.renderNow();
        }
      },
      /** Force un rendu immediat, sans attendre le ticker (suspendu hors focus). */
      render(): void {
        stage.renderNow();
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

/** Ecrit le HUD dans le DOM a partir du contenu pur calcule par `hudInfo` (§4.6). */
function updateHud(state: RenderState, client: GameClient): void {
  const info = hudInfo(state, client.level, client.hordeTick);
  hudHp.textContent = `${info.hp}`;
  hudLevel.textContent = `${info.level}`;
  hudTimer.textContent = `Temps ${info.timer}`;
  hudLateDeaths.textContent = `${client.lateDeaths}`;
}

/** Affiche l'ecran de bilan (§7) — appele une seule fois, a la reception de `RUN_OVER`. */
function showSummary(result: RunOverSummary): void {
  const info = formatSummary(result);
  summaryTime.textContent = info.time;
  summaryLevel.textContent = `${info.level}`;
  summaryKills.textContent = `${info.kills}`;
  summary.classList.remove('hidden');
  summary.classList.add('flex');
}
