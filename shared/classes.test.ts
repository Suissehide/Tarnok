import { describe, expect, it } from 'vitest';

import { CLASSES, classOf, DEFAULT_CLASS_ID, type GameClass } from './classes';

describe('etape 8 tache 1 : le catalogue des classes', () => {
  it('porte exactement quatre classes, aux identifiants 0 a 3', () => {
    // ⚠️ Nombre NU : c'est une decision de la spec (§6), pas un reglage de jeu.
    expect(CLASSES.length).toBe(4);
    expect(CLASSES.map((c) => c.id)).toEqual([0, 1, 2, 3]);
  });

  it('chaque classe a un verbe et un trait DISTINCTS des autres', () => {
    expect(new Set(CLASSES.map((c) => c.verb)).size).toBe(CLASSES.length);
    expect(new Set(CLASSES.map((c) => c.trait)).size).toBe(CLASSES.length);
  });

  it('aucune classe ne porte d element ni d arme — le TYPE ne le permet pas', () => {
    // ⚠️ Ce test n'est PAS le garde structurel : le garde, c'est que `GameClass`
    // n'a aucun champ d'element ni d'arme. Un test textuel serait du theatre —
    // la lecon de la tache 1 de l'etape 7b. Celui-ci epingle seulement que les
    // clefs du catalogue restent les quatre attendues, donc qu'aucune n'a ete
    // ajoutee en douce.
    for (const c of CLASSES) {
      expect(Object.keys(c).sort()).toEqual(['id', 'label', 'trait', 'verb']);
    }
  });

  it('classOf rend la classe par son identifiant, et undefined hors catalogue', () => {
    expect(classOf(DEFAULT_CLASS_ID)?.id).toBe(DEFAULT_CLASS_ID);
    expect(classOf(CLASSES.length)).toBeUndefined();
    expect(classOf(-1)).toBeUndefined();
    expect(classOf(255)).toBeUndefined();
  });

  it('le tableau est gele : on ne peut ni ajouter ni remplacer une entree', () => {
    expect(() => {
      (CLASSES as GameClass[]).push({ id: 9, label: 'x', verb: 'amorce', trait: 'residuPartout' });
    }).toThrow();
    expect(() => {
      (CLASSES as GameClass[])[0] = { id: 9, label: 'x', verb: 'amorce', trait: 'residuPartout' };
    }).toThrow();
    expect(CLASSES.length).toBe(4);
  });

  it('le catalogue est gele : une ecriture ne passe pas', () => {
    const premiere = CLASSES[0] as GameClass;
    expect(() => {
      (premiere as { label: string }).label = 'autre';
    }).toThrow();
  });
});
