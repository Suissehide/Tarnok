// @vitest-environment jsdom
import { PING_INTENTS } from '@shared/ping';
import { describe, expect, it, vi } from 'vitest';

import { PING_DEADZONE_PX, PingWheel, pingSectorAt } from './ping-wheel';

const I = (nom: (typeof PING_INTENTS)[number]) => PING_INTENTS.indexOf(nom);

describe('pingSectorAt : quatre secteurs de 90 degres, y vers le bas', () => {
  it('les quatre directions franches', () => {
    expect(pingSectorAt(0, -100)).toBe(I('danger'));
    expect(pingSectorAt(100, 0)).toBe(I('jePrends'));
    expect(pingSectorAt(0, 100)).toBe(I('viens'));
    expect(pingSectorAt(-100, 0)).toBe(I('boss'));
  });

  it('les diagonales exactes tombent sur l axe vertical', () => {
    expect(pingSectorAt(50, -50)).toBe(I('danger'));
    expect(pingSectorAt(-50, 50)).toBe(I('viens'));
  });

  it('la zone morte vaut un clic bref : viens', () => {
    expect(pingSectorAt(PING_DEADZONE_PX - 1, 0)).toBe(I('viens'));
    expect(pingSectorAt(0, -(PING_DEADZONE_PX - 1))).toBe(I('viens'));
    expect(pingSectorAt(PING_DEADZONE_PX + 1, 0)).toBe(I('jePrends'));
  });
});

function pointeur(type: string, x: number, y: number, button = 2): Event {
  const e = new MouseEvent(type, { clientX: x, clientY: y, button });
  return e;
}

function monte(canOpen = () => true) {
  const element = document.createElement('div');
  element.classList.add('hidden');
  const events = new EventTarget();
  const onPing = vi.fn();
  const wheel = new PingWheel({
    element,
    canOpen: () => canOpen(),
    toWorld: (sx, sy) => ({ x: sx * 10, y: sy * 10 }),
    onPing,
    events,
  });
  return { element, events, onPing, wheel };
}

describe('PingWheel : le geste du clic droit', () => {
  it('ouvrir, glisser a droite, relacher : je prends, au point d OUVERTURE', () => {
    const { element, events, onPing, wheel } = monte();
    events.dispatchEvent(pointeur('pointerdown', 100, 100));
    expect(wheel.isOpen).toBe(true);
    expect(element.classList.contains('hidden')).toBe(false);
    events.dispatchEvent(pointeur('pointermove', 180, 105));
    events.dispatchEvent(pointeur('pointerup', 180, 105));
    expect(onPing).toHaveBeenCalledWith(I('jePrends'), 1000, 1000);
    expect(wheel.isOpen).toBe(false);
    expect(element.classList.contains('hidden')).toBe(true);
  });

  it('un clic bref envoie viens', () => {
    const { events, onPing } = monte();
    events.dispatchEvent(pointeur('pointerdown', 50, 50));
    events.dispatchEvent(pointeur('pointerup', 52, 51));
    expect(onPing).toHaveBeenCalledWith(I('viens'), 500, 500);
  });

  it('le clic gauche n ouvre rien', () => {
    const { events, onPing, wheel } = monte();
    events.dispatchEvent(pointeur('pointerdown', 50, 50, 0));
    expect(wheel.isOpen).toBe(false);
    events.dispatchEvent(pointeur('pointerup', 50, 50, 0));
    expect(onPing).not.toHaveBeenCalled();
  });

  it('hors jeu, la roue ne s ouvre pas', () => {
    const { events, onPing, wheel } = monte(() => false);
    events.dispatchEvent(pointeur('pointerdown', 50, 50));
    expect(wheel.isOpen).toBe(false);
    events.dispatchEvent(pointeur('pointerup', 90, 50));
    expect(onPing).not.toHaveBeenCalled();
  });

  it('la perte de focus ferme la roue sans rien envoyer', () => {
    const { events, onPing, wheel } = monte();
    events.dispatchEvent(pointeur('pointerdown', 50, 50));
    events.dispatchEvent(new Event('blur'));
    expect(wheel.isOpen).toBe(false);
    events.dispatchEvent(pointeur('pointerup', 150, 50));
    expect(onPing).not.toHaveBeenCalled();
  });

  it('un pointercancel ferme la roue sans rien envoyer', () => {
    const { events, onPing, wheel } = monte();
    events.dispatchEvent(pointeur('pointerdown', 50, 50));
    expect(wheel.isOpen).toBe(true);
    events.dispatchEvent(new Event('pointercancel'));
    expect(wheel.isOpen).toBe(false);
    events.dispatchEvent(pointeur('pointerup', 150, 50));
    expect(onPing).not.toHaveBeenCalled();
  });

  it('l etalage qui s ouvre pendant la roue la ferme sans rien envoyer', () => {
    let enJeu = true;
    const { events, onPing, wheel } = monte(() => enJeu);
    events.dispatchEvent(pointeur('pointerdown', 50, 50));
    enJeu = false;
    wheel.update();
    expect(wheel.isOpen).toBe(false);
    events.dispatchEvent(pointeur('pointerup', 150, 50));
    expect(onPing).not.toHaveBeenCalled();
  });
});
