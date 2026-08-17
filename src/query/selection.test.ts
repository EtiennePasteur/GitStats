import { describe, it, expect } from 'vitest';
import { toggleSelection, effectiveSelection, isSelectionFull } from './selection';

const DEFAULT = ['a', 'b', 'c'];
const MAX = 5;

describe('effectiveSelection', () => {
  it('affiche le défaut tant que rien n\'a été choisi', () => {
    expect(effectiveSelection(null, DEFAULT)).toEqual(['a', 'b', 'c']);
  });

  it('distingue « rien choisi » de « tout retiré »', () => {
    // Deux états visuellement opposés qui doivent le rester.
    expect(effectiveSelection(null, DEFAULT)).toEqual(DEFAULT);
    expect(effectiveSelection([], DEFAULT)).toEqual([]);
  });
});

describe('toggleSelection — le bug de la sélection par défaut', () => {
  it('RETIRE un élément du défaut au premier clic, au lieu de le rajouter', () => {
    // C'est le cœur du problème : sans matérialisation du défaut, ce clic
    // produisait ['b'] — la personne qu'on voulait enlever restait seule.
    expect(toggleSelection(null, DEFAULT, 'b', MAX)).toEqual(['a', 'c']);
  });

  it('retire n\'importe lequel des éléments par défaut', () => {
    expect(toggleSelection(null, DEFAULT, 'a', MAX)).toEqual(['b', 'c']);
    expect(toggleSelection(null, DEFAULT, 'c', MAX)).toEqual(['a', 'b']);
  });

  it('ajoute un élément absent du défaut', () => {
    expect(toggleSelection(null, DEFAULT, 'z', MAX)).toEqual(['a', 'b', 'c', 'z']);
  });

  it('permet de tout retirer, un par un', () => {
    let state = toggleSelection(null, DEFAULT, 'a', MAX);
    state = toggleSelection(state, DEFAULT, 'b', MAX);
    state = toggleSelection(state, DEFAULT, 'c', MAX);
    // Sélection vide assumée : elle ne doit pas repartir sur le défaut.
    expect(state).toEqual([]);
    expect(effectiveSelection(state, DEFAULT)).toEqual([]);
  });

  it('est réversible : retirer puis remettre revient au même ensemble', () => {
    const removed = toggleSelection(null, DEFAULT, 'b', MAX);
    const restored = toggleSelection(removed, DEFAULT, 'b', MAX);
    expect([...restored].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('toggleSelection — borne maximale', () => {
  const full = ['a', 'b', 'c', 'd', 'e'];

  it('ignore un ajout au-delà de la limite', () => {
    expect(toggleSelection(full, DEFAULT, 'f', MAX)).toEqual(full);
  });

  it('autorise toujours un retrait, même à la limite', () => {
    expect(toggleSelection(full, DEFAULT, 'c', MAX)).toEqual(['a', 'b', 'd', 'e']);
  });

  it('laisse de la place après un retrait', () => {
    const freed = toggleSelection(full, DEFAULT, 'c', MAX);
    expect(toggleSelection(freed, DEFAULT, 'f', MAX)).toEqual(['a', 'b', 'd', 'e', 'f']);
  });
});

describe('toggleSelection — immuabilité', () => {
  it('ne mute jamais l\'entrée', () => {
    const current = ['a', 'b'];
    const fallback = [...DEFAULT];
    toggleSelection(current, fallback, 'a', MAX);
    toggleSelection(null, fallback, 'a', MAX);
    expect(current).toEqual(['a', 'b']);
    expect(fallback).toEqual(['a', 'b', 'c']);
  });
});

describe('isSelectionFull', () => {
  it('ne bloque pas tant qu\'il reste de la place', () => {
    expect(isSelectionFull(null, DEFAULT, 'z', MAX)).toBe(false);
  });

  it('bloque un nouvel élément une fois la limite atteinte', () => {
    const full = ['a', 'b', 'c', 'd', 'e'];
    expect(isSelectionFull(full, DEFAULT, 'f', MAX)).toBe(true);
  });

  it('ne bloque jamais un élément déjà sélectionné, sinon il serait impossible à retirer', () => {
    const full = ['a', 'b', 'c', 'd', 'e'];
    expect(isSelectionFull(full, DEFAULT, 'c', MAX)).toBe(false);
  });
});
