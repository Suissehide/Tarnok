import type { LobbyMessage } from '@shared/protocol';
import { bonusesOf } from '@shared/shop';
import { weaponOf } from '@shared/weapons';

import { Keyboard } from './input/keyboard';
import { Mouse } from './input/mouse';
import { acheter, fetchCompte, tokenBytes, tokenText } from './net/account';
import { type ConnectionStatus, GameClient, type InputAxes, type RenderState } from './net/client';
import { composeFrame } from './render/frame';
import { unitSheets } from './render/player-renderer';
import { formatTimer, hudInfo, Stage } from './render/stage';
import { preloadSheets, terrainSheets } from './render/terrain-renderer';
import '@fontsource/metamorphous';
import '@fontsource/jersey-15';
import '@fontsource/alegreya-sans/400.css';
import '@fontsource/alegreya-sans/700.css';
import '@fontsource/space-mono';
import './styles/main.css';

import { AudioEngine, type CueSnapshot, cuesBetween } from './audio/audio';
import { renderCombos } from './ui/combos';
import { API_URL, ASSETS_BASE, gameSocketUrl } from './ui/config';
import { DraftScreen } from './ui/draft';
import {
  type AbilityElements,
  type HudElements,
  paintAbility,
  paintHud,
  paintWeapons,
} from './ui/hud';
import {
  easeBar,
  funnyLine,
  LOADING_MIN_MS,
  type LoadingState,
  loadingProgress,
  paintLoading,
  tipFor,
} from './ui/loading';
import { Minimap } from './ui/minimap';
import { wireOptions } from './ui/options';
import { formatGold, PortalScreen } from './ui/portal';
import { type RoomStep, renderRoom } from './ui/room';
import { loadPick, loadSettings, savePick, saveSettings } from './ui/settings';
import { type EtatBoutique, messageAchat, renderShop } from './ui/shop';
import { applySkin } from './ui/skin';
import { paintSummary, type SummaryElements, summaryTone } from './ui/summary';

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

/** Replie ou deplie l'aide des combinaisons (un onglet, replie par defaut). */
function toggleCombos(): void {
  const panel = el('hud-combos-panel');
  const open = panel.classList.toggle('hidden') === false;
  el('hud-combos-toggle').setAttribute('aria-expanded', String(open));
}

// Sans attendre : les menus s'affichent d'abord en cadres unis, puis
// s'habillent d'un bloc (voir `ui/skin.ts`).
void applySkin();

// Le canevas des ecrans fait 1920 x 1080 (maquette) : on le met a l'echelle
// uniformement plutot que de reflower, comme le demande le README de la maquette.
const fitCanvas = (): void => {
  const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  document.documentElement.style.setProperty('--ui-scale', `${scale}`);
};
fitCanvas();
window.addEventListener('resize', fitCanvas);

const lobby = el('lobby');
const room = el('room');
const pause = el('pause');
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
const hudPassiveList = el('hud-passive-list');
const summary = el('summary');
const errorLine = el('error');
const codeInput = el<HTMLInputElement>('code');
const goldLine = el('account-gold');
const shopGold = el('shop-gold');
const shopError = el('shop-error');
const shopRoot = el('shop');
const shopScreen = el('shop-screen');

/** Le solde du compte, partout ou il s'affiche (menu et boutique). */
const paintAccountGold = (texte: string): void => {
  const lisible = /^\d+$/.test(texte) ? formatGold(Number(texte)) : texte;
  goldLine.textContent = lisible;
  shopGold.textContent = lisible;
};

el<HTMLButtonElement>('open-shop').addEventListener('click', () => {
  shopError.textContent = '';
  lobby.classList.add('hidden');
  shopScreen.classList.remove('hidden');
});
// Les options (maquette 07) : gardees dans ce navigateur, appliquees au
// depart de chaque partie.
let settings = loadSettings();
// Le son : synthetise (`audio/audio.ts`), reveille au premier geste du joueur
// — les navigateurs refusent de jouer avant. La musique du menu d'abord.
const audio = new AudioEngine(settings);
audio.playMusic('menu');
const unlockAudio = (): void => audio.unlock();
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', unlockAudio);
// Un petit clic sur chaque bouton de l'interface.
document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement | null)?.closest('button')) {
    audio.play('click');
  }
});
const optionsScreen = el('options-screen');
const options = wireOptions(
  optionsScreen,
  () => settings,
  (draft) => {
    settings = draft;
    audio.setVolumes(draft);
    el('options-status').textContent = saveSettings(draft)
      ? 'Options enregistrées.'
      : 'Options appliquées pour cette session (stockage indisponible).';
  },
  () => {
    optionsScreen.classList.add('hidden');
    lobby.classList.remove('hidden');
  },
  // Les volumes s'entendent pendant qu'on les regle.
  (draft) => audio.setVolumes(draft),
);
el<HTMLButtonElement>('open-options').addEventListener('click', () => {
  el('options-status').textContent = '';
  options.open();
  lobby.classList.add('hidden');
  optionsScreen.classList.remove('hidden');
});
el<HTMLButtonElement>('close-shop').addEventListener('click', () => {
  shopScreen.classList.add('hidden');
  lobby.classList.remove('hidden');
});

/** Les cases du HUD, cherchees une fois — c'est `paintHud` qui decide de leur contenu. */
const hudElements: HudElements = {
  hp: hudHp,
  hpFill: el('hud-hp-fill'),
  xpFill: el('hud-xp-fill'),
  xpLabel: el('hud-xp-label'),
  portrait: el<HTMLImageElement>('hud-portrait'),
  kills: el('hud-kills'),
  weapons: el('hud-weapons'),
  level: hudLevel,
  timer: hudTimer,
  lateDeaths: hudLateDeaths,
  synergyFill: hudSynergyFill,
  synergyLabel: hudSynergyLabel,
  gold: hudGold,
  freeze: hudFreeze,
  passiveList: hudPassiveList,
};

const summaryElements: SummaryElements = {
  root: summary,
  title: el('summary-title'),
  portrait: el<HTMLImageElement>('summary-portrait'),
  name: el('summary-name'),
  time: el('summary-time'),
  level: el('summary-level'),
  kills: el('summary-kills'),
  gold: el('summary-gold'),
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
      paintAccountGold(compte.gold);
      accountPurchases = compte.purchases;
      renderShop(shopRoot, etatBoutique(compte), (itemId) => onBuy(texte, itemId));
    } else {
      paintAccountGold('—');
    }
  } catch {
    paintAccountGold('—');
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
  shopError.textContent = '';
  try {
    const reponse = await acheter(API_URL, texte, itemId);
    if (reponse.ok) {
      paintAccountGold(reponse.gold);
      accountPurchases = reponse.purchases;
      renderShop(shopRoot, etatBoutique(reponse), (id) => onBuy(texte, id));
    } else {
      // Amendement, point 3 : 402 (gagner plus d'or) et 409 (rafraichir et
      // retenter) ne disent PAS la meme chose — voir `messageAchat`.
      shopError.textContent = messageAchat(reponse.status);
    }
  } catch (cause) {
    shopError.textContent = `Achat impossible : ${(cause as Error).message}`;
  }
}

let accountToken: Uint8Array | null = null;
/**
 * Les achats de ce compte, tels que lus (ou rafraichis par un achat) au fil
 * de la session — la meme donnee que la boutique, au meme instant. Fixes
 * pour la duree d'un salon : la boutique disparait de l'ecran une fois
 * `join()` appelee, donc les bonus du miroir client ne bougent plus.
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

  const minimap = new Minimap(el<HTMLCanvasElement>('hud-minimap'));
  const abilityElements: AbilityElements = {
    box: el('hud-ability'),
    icon: el<HTMLImageElement>('hud-ability-icon'),
    cooldown: el('hud-ability-cooldown'),
    name: el('hud-ability-name'),
  };
  let lastMinimap = 0;
  let lastKnownKey: string | null = null;

  // L'ecran de chargement (maquette 03) : il couvre le depart, de « Lancer la
  // partie » a la premiere image ou le joueur se voit. Les planches du
  // terrain se prechargent DES la salle d'attente, pour que le depart soit court.
  const loadingEl = {
    root: el('loading'),
    label: el('loading-label'),
    percent: el('loading-percent'),
    fill: el('loading-fill'),
  };
  el('loading-tip').textContent = tipFor(code);
  const loading: LoadingState = {
    launched: false,
    mapReady: false,
    assetsLoaded: 0,
    assetsTotal: 0,
    terrainReady: false,
    firstSnapshot: false,
  };
  let terrainLoaded = 0;
  let unitsLoaded = 0;
  let unitsTotal = 0;
  const terrainTotal = terrainSheets().length;
  const syncAssets = (): void => {
    loading.assetsLoaded = terrainLoaded + unitsLoaded;
    loading.assetsTotal = terrainTotal + unitsTotal;
  };
  void preloadSheets(ASSETS_BASE, terrainSheets(), (n) => {
    terrainLoaded = n;
    syncAssets();
  });
  let loadingTimer: number | null = null;
  const showLoading = (): void => {
    if (loadingTimer !== null) {
      return;
    }
    loadingEl.root.classList.remove('hidden');
    const depuis = performance.now();
    const tick = (): void => {
      // Le salon n'a jamais demarre (depart refuse, socket coupee) : on rend
      // la salle d'attente plutot que de charger indefiniment.
      if (!loading.mapReady && performance.now() - depuis > 15_000 && loadingTimer !== null) {
        window.clearInterval(loadingTimer);
        loadingTimer = null;
        loading.launched = false;
        loadingEl.root.classList.add('hidden');
        roomElements.hint.textContent = 'Le salon n’a pas démarré — réessayez.';
        return;
      }
      loading.firstSnapshot = client.localPosition !== null;
      const view = loadingProgress(loading);
      const now = performance.now();
      // La jauge AFFICHEE court vers la vraie, sans sauter ni se figer, et une
      // phrase du theme defile dessous.
      shown = easeBar(shown, view.ratio, now - lastTick);
      lastTick = now;
      paintLoading(loadingEl, {
        label: funnyLine(now - depuis, code.charCodeAt(0)),
        ratio: shown,
        done: view.done,
      });
      if (view.done && shown >= 0.995 && now - depuis >= LOADING_MIN_MS && loadingTimer !== null) {
        window.clearInterval(loadingTimer);
        loadingEl.root.classList.add('hidden');
        room.classList.add('hidden');
        hud.classList.remove('hidden');
        audio.playMusic('game');
        // Les options du joueur, au depart de la partie.
        el('hud-minimap').parentElement?.classList.toggle('hidden', !settings.minimap);
        if (settings.combosOpen) {
          toggleCombos();
        }
      }
    };
    let shown = 0;
    let lastTick = depuis;
    tick();
    loadingTimer = window.setInterval(tick, 50);
  };

  /** Menu Echap ouvert : les entrees de CE joueur sont coupees (le monde, lui, tourne). */
  let paused = false;
  const setPaused = (value: boolean): void => {
    paused = value;
    pause.classList.toggle('hidden', !value);
  };
  const leave = (): void => {
    client.disconnect();
    // Meme reinitialisation que le bilan : `Stage`/`Keyboard` ne se
    // demontent pas proprement, et le lobby se recharge de toute facon.
    window.location.reload();
  };

  const client = new GameClient(
    gameSocketUrl(code),
    () => (paused ? { x: 0, y: 0 } : keyboard.axes()),
    onStatus,
    (result) => {
      setPaused(false);
      paintSummary(
        summaryElements,
        result,
        summaryTone(client.portalDecision, client.portalGold, client.gold),
        client.localId,
        client.localClassId,
      );
    },
    () => (paused ? { x: 0, y: 0 } : readAim()),
    // Tache 28 : la carte n'existe qu'a partir du WELCOME (graine recue),
    // donc on ne peut dessiner les obstacles qu'a ce moment-la — jamais avant.
    // C'est aussi l'instant ou la salle d'attente cede la place au jeu.
    (map) => {
      loading.launched = true;
      loading.mapReady = true;
      showLoading();
      // Les unites de CETTE partie : une par joueur, sa classe et sa couleur.
      const unites = (lastLobby?.players ?? []).flatMap((p) => {
        const u = unitSheets(p.playerId, p.classId);
        return [u.idle, u.run];
      });
      unitsTotal = unites.length;
      syncAssets();
      void preloadSheets(ASSETS_BASE, unites, (n) => {
        unitsLoaded = n;
        syncAssets();
      });
      void stage.drawObstacles(map).then(() => {
        loading.terrainReady = true;
      });
      minimap.setObstacles(map);
    },
    accountToken,
    // Les bonus permanents du compte, pour le MIROIR DE PREDICTION (revue
    // finale de l'etape 7b). Derives ici des memes `accountPurchases` que le
    // grisage de l'etalage juste en dessous, avec la fonction que `Room`
    // applique (`bonusesOf`, descendue dans `shared/shop.ts`) : zero octet de
    // plus sur le fil, et aucune seconde formule.
    //
    // ⚠️ **Calcules a la construction, une seule fois.** Le serveur pose ces
    // bonus au `join` et ils sont constants sur toute la run ; la boutique
    // disparait de l'ecran des que `join()` est appelee, donc `accountPurchases`
    // ne peut plus changer sous les pieds du client. Meme propriete que celle
    // que `DraftScreen` tient deja.
    bonusesOf(new Map(Object.entries(accountPurchases))),
  );
  const roomElements = {
    players: el('room-players'),
    stepClass: el<HTMLButtonElement>('room-step-class'),
    stepWeapon: el<HTMLButtonElement>('room-step-weapon'),
    classes: el('room-classes'),
    weapons: el('room-weapons'),
    start: el<HTMLButtonElement>('room-start'),
    hint: el('room-hint'),
  };
  // La classe d'abord, l'arme ensuite (`ui/room.ts`) : l'etape courante vit
  // ici, et l'ecran se repeint a chaque `LOBBY` comme a chaque changement d'etape.
  let roomStep: RoomStep = 'classe';
  let lastLobby: LobbyMessage | null = null;
  const paintRoom = (): void => {
    if (lastLobby) {
      renderRoom(
        roomElements,
        lastLobby,
        roomStep,
        (weaponId, classId) => {
          savePick(weaponId, classId);
          client.pick(weaponId, classId);
        },
        (step) => {
          roomStep = step;
          paintRoom();
        },
      );
    }
  };
  client.onLobby = (state) => {
    // Premier LOBBY de la page (quitter recharge) : on rejoue le dernier choix garde.
    const saved = lastLobby === null ? loadPick() : null;
    if (saved) {
      client.pick(saved.weaponId, saved.classId);
    }
    lastLobby = state;
    paintRoom();
  };
  roomElements.start.addEventListener('click', () => {
    loading.launched = true;
    showLoading();
    client.startRun();
  });
  el<HTMLButtonElement>('room-leave').addEventListener('click', leave);
  el<HTMLButtonElement>('pause-resume').addEventListener('click', () => setPaused(false));
  el<HTMLButtonElement>('pause-quit').addEventListener('click', leave);
  window.addEventListener('keydown', (e) => {
    // En jeu seulement : ni en salle d'attente, ni sur le bilan.
    if (
      e.key === 'Escape' &&
      !hud.classList.contains('hidden') &&
      summary.classList.contains('hidden')
    ) {
      setPaused(!paused);
    }
    // Espace : le verbe de la classe, vise au curseur (a defaut, sur soi). Le
    // client PROPOSE ; c'est l'annonce du salon qui dira s'il a eu lieu.
    if (e.code === 'Space' && !hud.classList.contains('hidden') && !paused) {
      e.preventDefault();
      if (!e.repeat) {
        const screen = mouse.screenPosition();
        const vise = screen ? stage.screenToWorld(screen.x, screen.y) : client.localPosition;
        if (vise) {
          client.useAbility(vise.x, vise.y);
        }
      }
    }
    // H replie ou deplie l'aide des combinaisons, en jeu seulement.
    if (e.key.toLowerCase() === 'h' && !hud.classList.contains('hidden') && !paused) {
      toggleCombos();
    }
  });
  // Et au clic sur son titre : la touche seule ne se decouvre pas.
  el('hud-combos-toggle').addEventListener('click', toggleCombos);

  client.connect();

  // L'etalage du §7.2 : il se met a jour a chaque image, dans `renderFrame`.
  // Un ecran a part entiere plutot qu'un bout de HUD, parce que c'est le
  // moment le plus social de la partie (§7.1 de l'orientation) et qu'il doit
  // montrer les jetons des quatre joueurs.
  const draftScreen = new DraftScreen(el('draft'), el('draft-status'), el('draft-cards'), client);

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
  room.classList.remove('hidden');
  el('room-code').textContent = code;
  const copy = el<HTMLButtonElement>('room-copy');
  copy.onclick = () => {
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        copy.textContent = 'Copié !';
      })
      .catch(() => {
        // Presse-papiers refuse (page non securisee) : on montre le code a la place.
        copy.textContent = code;
      })
      .finally(() => {
        window.setTimeout(() => {
          copy.textContent = 'Copier le code';
        }, 1500);
      });
  };
  roomElements.hint.textContent = 'Connexion au salon…';
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
      paintAbility(abilityElements, client.localClassId, client.abilityCooldownTicks);
      // La mini-carte a 10 Hz : des milliers de points, inutile a chaque image.
      const now = performance.now();
      if (now - lastMinimap > 100) {
        lastMinimap = now;
        minimap.draw({
          localId: client.localId,
          players: state.players,
          enemies: client.horde,
          boss: null,
        });
      }
      // L'aide des combinaisons met en avant ce que l'equipe peut declencher :
      // les elements de toutes les armes tenues. Repeinte seulement s'ils changent.
      const known = new Set<number>();
      for (const p of state.players) {
        for (const w of client.loadoutOf(p.id).weaponIds) {
          known.add(weaponOf(w).element);
        }
      }
      const knownKey = [...known].sort().join(',');
      if (knownKey !== lastKnownKey) {
        lastKnownKey = knownKey;
        renderCombos(el('hud-combos'), known);
      }
      // Le menu Echap montre la partie en cours (ecran 06) : il se lit par-dessus
      // un monde qui continue, donc il se repeint a chaque image.
      if (paused) {
        el('pause-time').textContent = formatTimer(client.hordeTick);
        el('pause-kills').textContent = formatGold(client.kills);
        el('pause-gold').textContent = formatGold(client.gold);
        el('pause-level').textContent = `${client.level}`;
        const id = client.localId;
        paintWeapons(el('pause-weapons'), id === null ? null : client.loadoutOf(id));
      }
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
  let lastCues: CueSnapshot | null = null;
  function renderFrame(now: number, dt: number): RenderState {
    const state = composeFrame(client, stage, screens, now, dt);
    // Le son de la partie, deduit de ce qui a change depuis l'image d'avant.
    if (!hud.classList.contains('hidden')) {
      const cur: CueSnapshot = {
        kills: client.kills,
        hits: client.hitCount,
        reactions: client.reactionCount,
        xp: state.xp,
        level: client.level,
        gold: client.gold,
        hp: state.players.find((p) => p.id === state.localId)?.hp ?? 0,
        bossCharging: client.bossCharge !== null,
        abilityCooldown: client.abilityCooldownTicks,
      };
      for (const cue of cuesBetween(lastCues, cur)) {
        audio.play(cue);
      }
      lastCues = cur;
    }
    return state;
  }

  stage.run(renderFrame);

  el<HTMLButtonElement>('summary-restart').addEventListener('click', leave);

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
  // Salle d'attente encore affichee et socket fermee : salon inconnu, plein ou
  // serveur coupe. Le dire plutot que laisser une liste vide.
  if (status === 'closed' && !room.classList.contains('hidden')) {
    el('room-hint').textContent = 'Connexion perdue — salon introuvable, plein ou serveur coupé.';
    el<HTMLButtonElement>('room-start').disabled = true;
  }
}
