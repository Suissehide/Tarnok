/**
 * Le son et la musique, SYNTHETISES dans le navigateur (Web Audio) : aucun
 * fichier, donc ni licence ni depot sur MinIO. Les effets sont de courtes
 * enveloppes d'oscillateurs et de bruit ; la musique est une boucle generee a
 * la volee, une gamme et une progression fixes, une melodie tiree d'une graine.
 *
 * ⚠️ **Le contexte audio nait au premier geste du joueur.** Les navigateurs
 * refusent de jouer un son avant une interaction (`unlock`) ; tout appel avant
 * ne fait rien, sans erreur.
 *
 * Ce qui DECLENCHE un effet vit ailleurs (`cuesBetween`, pur et teste) : ce
 * module ne fait que jouer.
 */

import { PING_INTENTS } from '@shared/ping';

export type Cue =
  | 'hit'
  | 'kill'
  | 'xp'
  | 'coin'
  | 'levelup'
  | 'hurt'
  | 'reaction'
  | 'charge'
  | 'ability'
  | 'click'
  | 'ping-viens'
  | 'ping-danger'
  | 'ping-boss'
  | 'ping-jePrends'
  | 'porteur';

/** Ce que le jeu observe a chaque image, pour en deduire les effets. */
export interface CueSnapshot {
  kills: number;
  hits: number;
  reactions: number;
  xp: number;
  level: number;
  gold: number;
  hp: number;
  bossCharging: boolean;
  abilityCooldown: number;
  /** Pings recus depuis la connexion (etape 9). */
  pings: number;
  /** Intention du dernier ping recu, `-1` si aucun. */
  lastPingIntent: number;
  /** Porteurs de coffre annonces depuis la connexion (etape 11). */
  porteurs: number;
}

/**
 * Les effets a jouer entre deux images. PURE : un compteur qui monte, une
 * jauge qui baisse, un etat qui bascule. `prev` nul (premiere image) ne joue
 * rien — sinon l'arrivee en partie sonnerait comme un festin.
 */
export function cuesBetween(prev: CueSnapshot | null, cur: CueSnapshot): Cue[] {
  if (!prev) {
    return [];
  }
  const out: Cue[] = [];
  if (cur.level > prev.level) {
    out.push('levelup');
  } else if (cur.xp > prev.xp) {
    out.push('xp');
  }
  if (cur.kills > prev.kills) {
    out.push('kill');
  } else if (cur.hits > prev.hits) {
    out.push('hit');
  }
  if (cur.reactions > prev.reactions) {
    out.push('reaction');
  }
  if (cur.gold > prev.gold) {
    out.push('coin');
  }
  if (cur.hp < prev.hp && cur.hp > 0) {
    out.push('hurt');
  }
  if (cur.bossCharging && !prev.bossCharging) {
    out.push('charge');
  }
  if (cur.abilityCooldown > prev.abilityCooldown) {
    out.push('ability');
  }
  if (cur.pings > prev.pings) {
    const cue = PING_CUES[cur.lastPingIntent];
    if (cue) {
      out.push(cue);
    }
  }
  if (cur.porteurs > prev.porteurs) {
    out.push('porteur');
  }
  return out;
}

/** Les volumes, de 0 a 100. */
export interface Volumes {
  master: number;
  music: number;
  sfx: number;
}

/** Le son de chaque intention, dans l'ordre de `PING_INTENTS`. */
const PING_CUES: readonly Cue[] = PING_INTENTS.map((i) => `ping-${i}` as Cue);

/** Un effet ne se rejoue pas plus souvent que ca, en secondes : une rafale de coups reste un son. */
const MIN_GAP_S: Record<Cue, number> = {
  hit: 0.07,
  kill: 0.06,
  xp: 0.05,
  coin: 0.08,
  levelup: 0.5,
  hurt: 0.25,
  reaction: 0.12,
  charge: 0.5,
  ability: 0.2,
  click: 0.05,
  'ping-viens': 0.15,
  'ping-danger': 0.15,
  'ping-boss': 0.15,
  'ping-jePrends': 0.15,
  porteur: 1,
};

/** Re pour la musique : une gamme dorienne, modale et un peu medievale. */
const DORIAN = [0, 2, 3, 5, 7, 9, 10];
const ROOT_HZ = 146.83; // Re3
const hz = (semitones: number): number => ROOT_HZ * 2 ** (semitones / 12);

/** Les accords de la boucle, en degres de la gamme (i, VII, IV, i). */
const PROGRESSION = [0, 6, 3, 0];

export type Track = 'menu' | 'game';

export class AudioEngine {
  #ctx: AudioContext | null = null;
  #master: GainNode | null = null;
  #musicBus: GainNode | null = null;
  #sfxBus: GainNode | null = null;
  #noise: AudioBuffer | null = null;
  #volumes: Volumes;
  #last = new Map<Cue, number>();
  #track: Track | null = null;
  #wanted: Track | null = null;
  #timer: number | null = null;
  #nextBeat = 0;
  #beat = 0;
  #melody = 0;

  constructor(volumes: Volumes) {
    this.#volumes = volumes;
  }

  /** A appeler sur un geste du joueur : cree ou reveille le contexte. */
  unlock(): void {
    if (!this.#ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) {
        return;
      }
      const ctx = new Ctor();
      this.#ctx = ctx;
      this.#master = ctx.createGain();
      this.#master.connect(ctx.destination);
      this.#musicBus = ctx.createGain();
      this.#musicBus.connect(this.#master);
      this.#sfxBus = ctx.createGain();
      this.#sfxBus.connect(this.#master);
      const len = Math.floor(ctx.sampleRate * 0.5);
      this.#noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.#noise.getChannelData(0);
      for (let i = 0; i < len; i++) {
        data[i] = Math.random() * 2 - 1;
      }
      this.setVolumes(this.#volumes);
      if (this.#wanted) {
        this.playMusic(this.#wanted);
      }
    }
    void this.#ctx.resume();
  }

  setVolumes(v: Volumes): void {
    this.#volumes = v;
    const t = this.#ctx?.currentTime ?? 0;
    // Courbe au carre : l'oreille entend le volume en logarithme.
    this.#master?.gain.setTargetAtTime((v.master / 100) ** 2, t, 0.02);
    this.#musicBus?.gain.setTargetAtTime(0.5 * (v.music / 100) ** 2, t, 0.02);
    this.#sfxBus?.gain.setTargetAtTime((v.sfx / 100) ** 2, t, 0.02);
  }

  /** Joue un effet, s'il n'a pas deja sonne a l'instant. */
  play(cue: Cue): void {
    const ctx = this.#ctx;
    const bus = this.#sfxBus;
    if (!ctx || !bus || ctx.state !== 'running') {
      return;
    }
    const now = ctx.currentTime;
    if (now - (this.#last.get(cue) ?? -1) < MIN_GAP_S[cue]) {
      return;
    }
    this.#last.set(cue, now);
    const tone = (
      type: OscillatorType,
      from: number,
      to: number,
      at: number,
      dur: number,
      gain: number,
    ): void => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(from, now + at);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, to), now + at + dur);
      g.gain.setValueAtTime(0.0001, now + at);
      g.gain.exponentialRampToValueAtTime(gain, now + at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, now + at + dur);
      o.connect(g).connect(bus);
      o.start(now + at);
      o.stop(now + at + dur + 0.02);
    };
    const noise = (at: number, dur: number, gain: number, freq: number): void => {
      if (!this.#noise) {
        return;
      }
      const src = ctx.createBufferSource();
      src.buffer = this.#noise;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain, now + at);
      g.gain.exponentialRampToValueAtTime(0.0001, now + at + dur);
      src.connect(f).connect(g).connect(bus);
      src.start(now + at);
      src.stop(now + at + dur + 0.02);
    };
    switch (cue) {
      case 'hit':
        noise(0, 0.05, 0.12, 2200);
        break;
      case 'kill':
        noise(0, 0.12, 0.2, 900);
        tone('square', 220, 90, 0, 0.1, 0.05);
        break;
      case 'xp':
        tone('sine', 880 + Math.random() * 120, 1320, 0, 0.09, 0.08);
        break;
      case 'coin':
        tone('square', 988, 988, 0, 0.07, 0.05);
        tone('square', 1319, 1319, 0.07, 0.16, 0.05);
        break;
      case 'levelup':
        [0, 4, 7, 12].forEach((s, k) => {
          tone('triangle', hz(12 + s), hz(12 + s), k * 0.09, 0.3, 0.12);
        });
        break;
      case 'porteur':
        // Un arpege ASCENDANT et brillant, plus haut et plus serre que
        // `levelup` : « quelque chose a chasser », pas « un palier franchi ».
        [0, 4, 7, 12, 16].forEach((s, k) => {
          tone('square', hz(19 + s), hz(19 + s), k * 0.06, 0.16, 0.06);
        });
        break;
      case 'hurt':
        tone('sawtooth', 160, 60, 0, 0.18, 0.12);
        noise(0, 0.1, 0.15, 400);
        break;
      case 'reaction':
        tone('sawtooth', 300, 1200, 0, 0.18, 0.06);
        noise(0.02, 0.25, 0.12, 3000);
        break;
      case 'charge':
        tone('sawtooth', 70, 45, 0, 0.7, 0.18);
        noise(0, 0.6, 0.1, 200);
        break;
      case 'ability':
        tone('triangle', 440, 880, 0, 0.15, 0.1);
        tone('sine', 660, 1320, 0.05, 0.2, 0.06);
        break;
      case 'ping-viens':
        tone('sine', 660, 660, 0, 0.12, 0.08);
        tone('sine', 880, 880, 0.1, 0.14, 0.08);
        break;
      case 'ping-danger':
        // Le plus percant des quatre : deux impulsions carrees, aigues.
        tone('square', 1320, 1100, 0, 0.08, 0.07);
        tone('square', 1320, 1100, 0.12, 0.08, 0.07);
        break;
      case 'ping-boss':
        tone('sawtooth', 220, 165, 0, 0.3, 0.09);
        break;
      case 'ping-jePrends':
        tone('triangle', 520, 780, 0, 0.12, 0.08);
        break;
      case 'click':
        tone('square', 600, 400, 0, 0.04, 0.04);
        break;
    }
  }

  /** Lance une piste (ou la garde pour le premier geste) ; `null` coupe. */
  playMusic(track: Track | null): void {
    this.#wanted = track;
    if (!this.#ctx || track === this.#track) {
      return;
    }
    this.#track = track;
    if (this.#timer !== null) {
      window.clearInterval(this.#timer);
      this.#timer = null;
    }
    if (!track) {
      return;
    }
    this.#nextBeat = this.#ctx.currentTime + 0.1;
    this.#beat = 0;
    this.#melody = 2;
    // Ordonnancement par anticipation : on pose les notes des 200 ms a venir.
    this.#timer = window.setInterval(() => this.#schedule(), 50);
  }

  #schedule(): void {
    const ctx = this.#ctx;
    const bus = this.#musicBus;
    if (!ctx || !bus || !this.#track) {
      return;
    }
    const game = this.#track === 'game';
    const beatS = 60 / (game ? 112 : 76);
    while (this.#nextBeat < ctx.currentTime + 0.2) {
      const t = this.#nextBeat;
      const bar = Math.floor(this.#beat / 4) % PROGRESSION.length;
      const chord = PROGRESSION[bar] ?? 0;
      const step = this.#beat % 4;
      const note = (degree: number, octave: number): number => {
        const d = ((degree % 7) + 7) % 7;
        const o = Math.floor(degree / 7) + octave;
        return hz((DORIAN[d] ?? 0) + 12 * o);
      };
      const voice = (type: OscillatorType, f: number, dur: number, gain: number): void => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = type;
        o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(bus);
        o.start(t);
        o.stop(t + dur + 0.05);
      };
      // La basse : la fondamentale de l'accord, au premier et troisieme temps.
      if (step === 0 || (game && step === 2)) {
        voice('triangle', note(chord, -1), beatS * (game ? 1.8 : 3.6), 0.22);
      }
      // L'accord tenu, doux, au debut de chaque mesure.
      if (step === 0) {
        for (const k of [0, 2, 4]) {
          voice('sine', note(chord + k, 0), beatS * 3.8, 0.05);
        }
      }
      // La melodie : une marche au hasard dans la gamme, accrochee a l'accord.
      if (game || step % 2 === 0) {
        const r = Math.random();
        this.#melody += r < 0.4 ? 1 : r < 0.8 ? -1 : r < 0.9 ? 2 : -2;
        this.#melody = Math.max(chord, Math.min(chord + 9, this.#melody));
        if (Math.random() < (game ? 0.8 : 0.6)) {
          voice('square', note(this.#melody, 1), beatS * 0.9, game ? 0.035 : 0.025);
        }
      }
      // En partie, un tambour de bruit sur les temps.
      if (game && this.#noise) {
        const src = ctx.createBufferSource();
        src.buffer = this.#noise;
        const f = ctx.createBiquadFilter();
        f.type = step % 2 === 0 ? 'lowpass' : 'highpass';
        f.frequency.value = step % 2 === 0 ? 180 : 6000;
        const g = ctx.createGain();
        g.gain.setValueAtTime(step % 2 === 0 ? 0.35 : 0.06, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + (step % 2 === 0 ? 0.18 : 0.05));
        src.connect(f).connect(g).connect(bus);
        src.start(t);
        src.stop(t + 0.25);
      }
      this.#nextBeat += beatS;
      this.#beat++;
    }
  }
}
