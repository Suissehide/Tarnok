import { Keyboard } from './input/keyboard';
import { Mouse } from './input/mouse';
import { acheter, fetchCompte, tokenBytes, tokenText } from './net/account';
import {
  type ConnectionStatus,
  GameClient,
  type InputAxes,
  type RenderState,
  type RunOverSummary,
} from './net/client';
import { composeFrame } from './render/frame';
import { formatSummary, hudInfo, Stage } from './render/stage';
import './styles/main.css';

import { API_URL, gameSocketUrl } from './ui/config';
import { DraftScreen } from './ui/draft';
import { type HudElements, paintHud } from './ui/hud';
import { PortalScreen } from './ui/portal';
import { type EtatBoutique, messageAchat, renderShop } from './ui/shop';

/**
 * Le DEMARRAGE, et rien d'autre : recherches DOM, `await stage.init()`,
 * gestionnaires de clic, et le cablage des trois objets vivants (client,
 * scene, ecrans) vers `composeFrame`.
 *
 * ⚠️ **Ce module n'est pas importable EN CONDITIONS REELLES, et c'est
 * assume.** Il fait son `await stage.init()` au niveau module ; l'importer
 * executerait tout le demarrage et construirait une `Application` Pixi
 * qu'aucun environnement de test ne sait instancier. La consequence a coute
 * trois etapes : le gel de niveau (etape 3), `draftScreen.update()` (etape
 * 4), puis `drawZones`, `drawReactionFlashes` et `paintSynergy` (etape 5a)
 * ont tous vecu ici sans qu'une seule assertion ne les garde.
 *
 * ⚠️ **Exception etroite (tache 8, etape 7b) : `main.test.ts` importe quand
 * meme ce module, mais avec `./render/stage` entierement remplace par un
 * double.** La vraie `Stage`, donc Pixi, n'y est jamais chargee — seul le
 * garde-fou autour de `await stage.init()` (son `catch` qui ecrit dans
 * `#error` avant de relancer) est exerce. Le reste du fichier (chargement du
 * compte, boutique, `join()`) reste sans assertion, pour la raison ci-dessus.
 *
 * La regle qui en sort, et qui tient tant que ce fichier reste maigre : **tout
 * ce qui DECIDE vit ailleurs** — `composeFrame` (`render/frame.ts`) pour ce
 * qui est dessine, `paintHud` (`ui/hud.ts`) pour ce qui est ecrit,
 * `Stage.composeWorld` pour les calques. Ici, il ne reste que les appels.
 */

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
const hudFreeze = el('hud-freeze');
const hudLateDeaths = el('hud-late-deaths');
const hudGold = el('hud-gold');
const hudSynergyFill = el('hud-synergy-fill');
const hudSynergyLabel = el('hud-synergy-label');
const hudPassives = el('hud-passives');
const hudPassiveList = el('hud-passive-list');
const summary = el('summary');
const summaryTime = el('summary-time');
const summaryLevel = el('summary-level');
const summaryKills = el('summary-kills');
const errorLine = el('error');
const codeInput = el<HTMLInputElement>('code');
const goldLine = el('account-gold');
const shopRoot = el('shop');

/** Les cases du HUD, cherchees une fois — c'est `paintHud` qui decide de leur contenu. */
const hudElements: HudElements = {
  hp: hudHp,
  level: hudLevel,
  timer: hudTimer,
  lateDeaths: hudLateDeaths,
  synergyFill: hudSynergyFill,
  synergyLabel: hudSynergyLabel,
  gold: hudGold,
  freeze: hudFreeze,
  passives: hudPassives,
  passiveList: hudPassiveList,
};

const keyboard = new Keyboard();
const stage = new Stage();
try {
  await stage.init(el('stage'));
} catch (cause) {
  // ⚠️ Un `await` de niveau module qui rejette ARRETE le module : tout ce qui
  // suit — le compte, les ecouteurs, la boutique — ne s'enregistre jamais.
  // Meme classe que le defaut I1 de l'etape 7a, dans ce meme fichier. Le
  // module s'arrete quand meme (sans canevas il n'y a pas de jeu), mais le
  // joueur VOIT pourquoi, au lieu d'une page blanche muette.
  errorLine.textContent = `Affichage impossible : ${(cause as Error).message}`;
  throw cause;
}
// La souris s'ecoute sur le canevas du jeu, cree par `stage.init` juste
// au-dessus : c'est lui qui sert de reference pour les coordonnees ecran
// (tache 13), et `Stage.screenToWorld` partage la meme camera.
const mouse = new Mouse(stage.canvas);

/**
 * Frappe le compte si besoin, puis affiche son solde.
 *
 * ⚠️ **Un echec reseau ne doit pas empecher de jouer.** Le solde est un
 * affichage ; si la base est injoignable pour le LIRE (`GET /accounts/me`
 * echoue), on joue sans le voir plutot que de bloquer l'ecran d'accueil.
 *
 * ⚠️ **Mais frapper un compte neuf (`mint`, via `tokenText`) peut echouer
 * pour de vrai, et c'est fatal pour cet appel-ci.** Sans jeton il n'y a rien
 * a faire tourner ; l'appelant (plus bas, au niveau module) encadre cet
 * appel d'un `try`/`catch` pour que ce rejet n'arrete pas l'execution du
 * module et laisse l'ecran d'accueil mort et muet — il ecrit plutot un
 * message dans `#error` et continue, boutons vivants, jeton `null`.
 *
 * ⚠️ **Ruling P9 du coordinateur : un `401` de `GET /accounts/me` reecrit le
 * jeton.** Un jeton bien forme mais inconnu du serveur — base reinitialisee
 * en developpement, par exemple — resterait sinon stocke pour toujours : la
 * poignee de main WebSocket le refuserait a chaque tentative, et le joueur ne
 * pourrait plus jamais jouer, sans rien a l'ecran qui le lui dise. `verifie`
 * ci-dessous est ce que `tokenText` appelle pour decider s'il faut re-frapper
 * (voir son docblock dans `net/account.ts`) ; elle ne traite QUE le 401 comme
 * un jeton mort — un 500 ou une panne reseau ne doivent pas faire perdre un
 * compte par ailleurs valide.
 */
async function chargeSolde(): Promise<string> {
  async function mint(): Promise<string> {
    const res = await fetch(`${API_URL}/accounts`, { method: 'POST' });
    if (!res.ok) {
      throw new Error(`POST /accounts : ${res.status}`);
    }
    return (await res.json()).token as string;
  }
  async function verifie(texte: string): Promise<boolean> {
    try {
      const res = await fetch(`${API_URL}/accounts/me`, {
        headers: { Authorization: `Bearer ${texte}` },
      });
      return res.status !== 401;
    } catch {
      return true;
    }
  }

  const texte = await tokenText(window.localStorage, mint, verifie);
  try {
    const compte = await fetchCompte(API_URL, texte);
    if (compte) {
      goldLine.textContent = compte.gold;
      accountPurchases = compte.purchases;
      renderShop(shopRoot, etatBoutique(compte), (itemId) => onBuy(texte, itemId));
    } else {
      goldLine.textContent = '—';
    }
  } catch {
    goldLine.textContent = '—';
  }
  return texte;
}

/** `CompteEtat` (gold en texte, cote fil) -> `EtatBoutique` (gold en `bigint`, cote boutique). */
function etatBoutique(compte: { gold: string; purchases: Record<string, number> }): EtatBoutique {
  return { gold: BigInt(compte.gold), purchases: compte.purchases };
}

/**
 * Le clic d'achat de la boutique : POST, puis reaffiche depuis la REPONSE
 * (qui porte `{ gold, purchases }`) plutot que de relire — un second aller-
 * retour serait un octet de latence gratuit pour une donnee qu'on a deja.
 *
 * ⚠️ **Un echec d'achat ne doit pas casser l'ecran.** Meme discipline que
 * `chargeSolde` : le message va dans `#error`, jamais une exception qui
 * remonterait jusqu'au niveau module.
 */
async function onBuy(texte: string, itemId: string): Promise<void> {
  errorLine.textContent = '';
  try {
    const reponse = await acheter(API_URL, texte, itemId);
    if (reponse.ok) {
      goldLine.textContent = reponse.gold;
      accountPurchases = reponse.purchases;
      renderShop(shopRoot, etatBoutique(reponse), (id) => onBuy(texte, id));
    } else {
      // Amendement, point 3 : 402 (gagner plus d'or) et 409 (rafraichir et
      // retenter) ne disent PAS la meme chose — voir `messageAchat`.
      errorLine.textContent = messageAchat(reponse.status);
    }
  } catch (cause) {
    errorLine.textContent = `Achat impossible : ${(cause as Error).message}`;
  }
}

let accountToken: Uint8Array | null = null;
/**
 * Les achats de ce compte, tels que lus (ou rafraichis par un achat) au fil
 * de la session — la meme donnee que la boutique, au meme instant. Fixes
 * pour la duree d'un salon : la boutique disparait de l'ecran une fois
 * `join()` appelee, donc `DraftScreen` ne peut pas la voir changer sous ses
 * pieds (§3.5 de la spec : « le grisage ne coute AUCUN octet », rien de neuf
 * ne transite par `DRAFT_OPEN`).
 */
let accountPurchases: Record<string, number> = {};
try {
  accountToken = tokenBytes(await chargeSolde());
} catch (cause) {
  // Base injoignable au tout premier chargement (mint echoue) : pas de
  // jeton, mais l'ecran reste vivant plutot que de s'arreter en silence.
  // Le serveur refusera la socket (pas de HELLO, §2.2) : voulu.
  errorLine.textContent = `Connexion impossible : ${(cause as Error).message}`;
}

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
    // Tache 28 : la carte n'existe qu'a partir du WELCOME (graine recue),
    // donc on ne peut dessiner les obstacles qu'a ce moment-la — jamais avant.
    (map) => stage.drawObstacles(map),
    accountToken,
  );
  client.connect();

  // L'etalage du §7.2 : il se met a jour a chaque image, dans `renderFrame`.
  // Un ecran a part entiere plutot qu'un bout de HUD, parce que c'est le
  // moment le plus social de la partie (§7.1 de l'orientation) et qu'il doit
  // montrer les jetons des quatre joueurs.
  //
  // `accountPurchases` grise les armes verrouillees non debloquees par CE
  // joueur (tache 8, ronde 1) : l'etalage tire sur l'union des pools de la
  // salle, donc une arme debloquee par un coequipier peut y apparaitre sans
  // que ce joueur-ci l'ait.
  const draftScreen = new DraftScreen(
    el('draft'),
    el('draft-status'),
    el('draft-cards'),
    client,
    accountPurchases,
  );

  // Le vote d'extraction du §6. Un BANDEAU, pas un modale : le monde ne
  // s'arrete pas pendant qu'on vote (voir `ui/portal.ts` et `index.html`).
  const portalScreen = new PortalScreen(
    el('portal'),
    el('portal-status'),
    el('portal-stakes'),
    el('portal-choices'),
    el('portal-voters'),
    client,
  );

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
   * Les trois ecrans HTML de l'image : le HUD (§4.6), l'etalage de cartes
   * (§7.2) et le vote d'extraction (§6 de l'etape 6a). Trois appels, sans
   * regle — la regle vit dans `paintHud`, dans `DraftScreen.update` et dans
   * `PortalScreen.update`, toutes trois gardees sous jsdom, et le fait qu'on
   * les appelle est garde par `frame.test.ts`.
   */
  const screens = {
    updateHud: (state: RenderState): void => {
      paintHud(
        hudElements,
        hudInfo(state, client.level, client.hordeTick, client.isFrozen),
        client.lateDeaths,
        state.synergy,
        // Tache 18 : la colonne des passifs lit le miroir d'inventaires que
        // le client tient depuis l'etape 4 — `paintHud` en derive les lignes.
        client,
      );
    },
    updateDraft: (): void => draftScreen.update(),
    updatePortal: (): void => portalScreen.update(),
  };

  /**
   * Une image complete. Le CONTENU de la boucle vit dans `composeFrame`
   * (`render/frame.ts`), ou chaque calque a son assertion ; il ne reste ici
   * que les trois objets vivants qu'on lui donne.
   *
   * Factorise entre le ticker Pixi (`stage.run`) et la poignee de debogage
   * `step()` ci-dessous, qui n'emprunte pas le ticker.
   */
  function renderFrame(now: number, dt: number): RenderState {
    return composeFrame(client, stage, screens, now, dt);
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
       * Rend aussi a chaque image : `composeFrame` ne fait que mettre a jour
       * la scene en memoire, c'est le ticker Pixi (rAF, donc suspendu hors
       * focus) qui la peint d'ordinaire. Sans ce rendu force, `step`
       * avancerait la simulation sans que le canevas ne le montre jamais.
       */
      step(count = 1, dt = 1 / 60): void {
        for (let i = 0; i < count; i++) {
          renderFrame(performance.now(), dt);
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

/** Affiche l'ecran de bilan (§7) — appele une seule fois, a la reception de `RUN_OVER`. */
function showSummary(result: RunOverSummary): void {
  const info = formatSummary(result);
  summaryTime.textContent = info.time;
  summaryLevel.textContent = `${info.level}`;
  summaryKills.textContent = `${info.kills}`;
  summary.classList.remove('hidden');
  summary.classList.add('flex');
}
