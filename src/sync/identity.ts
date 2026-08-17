/**
 * Résolution d'identité des contributeurs.
 *
 * L'API commits ne renvoie que `author_name` + `author_email` : aucun lien vers
 * un compte GitLab. Sans traitement, la même personne apparaît 3 ou 4 fois dans
 * les classements (poste perso, poste pro, e-mail noreply, faute de frappe dans
 * le nom) — et le comparatif entre utilisateurs devient inexploitable.
 *
 * Politique retenue :
 *  - fusion AUTOMATIQUE uniquement sur preuve forte (même e-mail normalisé) ;
 *  - fusion SUGGÉRÉE sur faisceau d'indices, jamais appliquée sans validation ;
 *  - fusion MANUELLE persistée, prioritaire sur tout le reste.
 *
 * Fusionner à tort deux personnes est bien plus grave que de ne pas les fusionner :
 * dans le doute, on ne fusionne pas.
 */

import type { StoredAuthor } from '../model/types';

export interface RawIdentity {
  name: string;
  email: string;
}

/** Retire les accents et la ponctuation pour comparer des noms. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    // Plage des diacritiques combinants, en échappements explicites : la forme
    // littérale est invisible à la relecture et survit mal aux copier-coller.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Normalise un e-mail en clé d'identité stable.
 *  - casse et espaces ignorés ;
 *  - sous-adressage `+tag` supprimé ;
 *  - e-mails noreply GitLab/GitHub (`12345-login@users.noreply.…`) réduits au login,
 *    ce qui les rattache automatiquement au compte correspondant.
 */
export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  if (trimmed === '') return '';

  const at = trimmed.lastIndexOf('@');
  if (at <= 0) return trimmed;

  let local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);

  if (domain.startsWith('users.noreply.')) {
    // `12345-login@users.noreply.gitlab.com` → `login`
    const match = /^\d+-(.+)$/.exec(local);
    return `noreply:${match?.[1] ?? local}`;
  }

  return `${local}@${domain}`;
}

/** Clé canonique d'une identité brute. Repli sur le nom si l'e-mail manque. */
export function identityKey(raw: RawIdentity): string {
  const email = normalizeEmail(raw.email);
  if (email !== '') return email;
  const name = normalizeName(raw.name);
  return name !== '' ? `name:${name}` : 'unknown';
}

/** Partie locale d'une clé d'identité (`prenom.nom@x.fr` → `prenom.nom`). */
export function localPart(key: string): string {
  if (key.startsWith('noreply:')) return key.slice('noreply:'.length);
  if (key.startsWith('name:')) return key.slice('name:'.length);
  const at = key.lastIndexOf('@');
  return at > 0 ? key.slice(0, at) : key;
}

export function emailDomain(key: string): string {
  const at = key.lastIndexOf('@');
  return at > 0 ? key.slice(at + 1) : '';
}

/**
 * Détecte les identités automatiques. Volontairement conservateur : un faux
 * positif fait disparaître une vraie personne des classements.
 */
export function isBotIdentity(raw: RawIdentity, patterns: string[]): boolean {
  const haystack = `${raw.name} ${raw.email}`.toLowerCase();
  return patterns.some((pattern) => {
    const needle = pattern.trim().toLowerCase();
    if (needle === '') return false;
    // Un motif nu comme `bot` ne doit pas matcher « Bottin » ou « Abbott » :
    // on exige une frontière non alphanumérique.
    if (/^[a-z0-9]+$/.test(needle)) {
      return new RegExp(`(^|[^a-z0-9])${needle}([^a-z0-9]|$)`).test(haystack);
    }
    return haystack.includes(needle);
  });
}

/** Structure union-find pour agréger les identités en personnes. */
export class IdentityResolver {
  private readonly parent = new Map<string, string>();
  /** Occurrences par (clé d'identité → nom → nombre de commits) pour choisir le nom d'affichage. */
  private readonly names = new Map<string, Map<string, number>>();
  private readonly emails = new Map<string, Set<string>>();
  private readonly weights = new Map<string, number>();

  constructor(manualAliases: Record<string, string> = {}) {
    for (const [from, to] of Object.entries(manualAliases)) {
      this.ensure(from);
      this.ensure(to);
      this.union(from, to, /* preferred */ to);
    }
  }

  private ensure(key: string): void {
    if (!this.parent.has(key)) {
      this.parent.set(key, key);
      this.names.set(key, new Map());
      this.emails.set(key, new Set());
      this.weights.set(key, 0);
    }
  }

  find(key: string): string {
    this.ensure(key);
    let root = key;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // Compression de chemin.
    let cursor = key;
    while (this.parent.get(cursor) !== root) {
      const next = this.parent.get(cursor)!;
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  union(a: string, b: string, preferred?: string): string {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return rootA;

    // La racine préférée gagne ; sinon celle qui pèse le plus de commits.
    let winner = rootA;
    let loser = rootB;
    if (preferred !== undefined) {
      const preferredRoot = this.find(preferred);
      if (preferredRoot === rootB) {
        winner = rootB;
        loser = rootA;
      }
    } else if ((this.weights.get(rootB) ?? 0) > (this.weights.get(rootA) ?? 0)) {
      winner = rootB;
      loser = rootA;
    }

    this.parent.set(loser, winner);
    const winnerNames = this.names.get(winner)!;
    for (const [name, count] of this.names.get(loser)!) {
      winnerNames.set(name, (winnerNames.get(name) ?? 0) + count);
    }
    const winnerEmails = this.emails.get(winner)!;
    for (const email of this.emails.get(loser)!) winnerEmails.add(email);
    this.weights.set(winner, (this.weights.get(winner) ?? 0) + (this.weights.get(loser) ?? 0));
    return winner;
  }

  /**
   * Enregistre une identité observée et renvoie l'identifiant de la personne.
   * `weight` = nombre de commits, utilisé pour élire le nom d'affichage.
   */
  observe(raw: RawIdentity, weight = 1): string {
    const key = identityKey(raw);
    this.ensure(key);
    const root = this.find(key);

    const displayName = raw.name.trim() !== '' ? raw.name.trim() : localPart(key);
    const names = this.names.get(root)!;
    names.set(displayName, (names.get(displayName) ?? 0) + weight);
    if (raw.email.trim() !== '') this.emails.get(root)!.add(raw.email.trim().toLowerCase());
    this.weights.set(root, (this.weights.get(root) ?? 0) + weight);

    return root;
  }

  /** Toutes les clés d'identité rattachées à une personne. */
  private keysOf(root: string): string[] {
    const keys: string[] = [];
    for (const key of this.parent.keys()) {
      if (this.find(key) === root) keys.push(key);
    }
    return keys;
  }

  /** Construit les personnes finales. Le nom retenu est le plus fréquent. */
  toAuthors(botPatterns: string[], manualAliases: Record<string, string> = {}): StoredAuthor[] {
    const roots = new Set<string>();
    for (const key of this.parent.keys()) roots.add(this.find(key));

    const manualRoots = new Set(Object.values(manualAliases).map((value) => this.find(value)));

    return [...roots].map((root) => {
      const names = this.names.get(root)!;
      let displayName = localPart(root);
      let best = -1;
      for (const [name, count] of names) {
        if (count > best) {
          best = count;
          displayName = name;
        }
      }
      const emails = [...this.emails.get(root)!];
      const primaryEmail = emails.find((email) => normalizeEmail(email) === root) ?? emails[0] ?? root;

      return {
        id: root,
        displayName,
        primaryEmail,
        identityKeys: this.keysOf(root).sort(),
        knownNames: [...names.keys()].sort(),
        knownEmails: emails.sort(),
        isBot: isBotIdentity({ name: displayName, email: primaryEmail }, botPatterns),
        manual: manualRoots.has(root) || undefined,
      } satisfies StoredAuthor;
    });
  }
}

/**
 * Aplatit les chaînes de fusion : `c → b` et `b → a` donnent `c → a`.
 *
 * Sans cet aplatissement, fusionner en trois temps laisserait des seaux pointant
 * sur un identifiant intermédiaire, et la personne apparaîtrait encore en double.
 * Les cycles éventuels (`a → b`, `b → a`, introduits par des allers-retours de
 * l'utilisateur) sont rompus au lieu de faire boucler la résolution.
 */
export function flattenAliases(aliases: Record<string, string>): Map<string, string> {
  const flat = new Map<string, string>();
  const settled = new Map<string, string>();

  const resolve = (start: string): string => {
    const cached = settled.get(start);
    if (cached !== undefined) return cached;

    // Marche le long de la chaîne en mémorisant le trajet, jusqu'à un terminus
    // ou un nœud déjà visité.
    const path: string[] = [];
    const positions = new Map<string, number>();
    let cursor = start;

    while (true) {
      const known = settled.get(cursor);
      if (known !== undefined) {
        for (const step of path) settled.set(step, known);
        return known;
      }
      if (positions.has(cursor)) {
        // Cycle détecté (l'utilisateur a fusionné a→b puis b→a). On élit un
        // représentant DÉTERMINISTE — le plus petit identifiant du cycle — et
        // on y rattache tous ses membres. Rompre en s'arrêtant simplement au
        // maillon précédent laisserait `a→b` et `b→a` coexister : la résolution
        // ne serait pas idempotente et les fusions oscilleraient.
        const cycle = path.slice(positions.get(cursor)!);
        const canonical = [...cycle].sort()[0]!;
        for (const member of cycle) settled.set(member, canonical);
        for (const step of path) settled.set(step, settled.get(step) ?? canonical);
        return canonical;
      }

      positions.set(cursor, path.length);
      path.push(cursor);

      const next = aliases[cursor];
      if (next === undefined || next === cursor) {
        // Terminus : c'est lui le représentant.
        for (const step of path) settled.set(step, cursor);
        return cursor;
      }
      cursor = next;
    }
  };

  for (const from of Object.keys(aliases)) resolve(from);

  // Un identifiant qui est son propre représentant n'a rien à faire dans la
  // table : `resolveAuthorId` le renvoie déjà tel quel.
  for (const [from, to] of settled) {
    if (from !== to) flat.set(from, to);
  }
  return flat;
}

/** Identifiant canonique d'une personne, une fois les fusions appliquées. */
export function resolveAuthorId(id: string, aliases: ReadonlyMap<string, string>): string {
  return aliases.get(id) ?? id;
}

/**
 * Fusionne les fiches d'auteurs selon les alias.
 *
 * La fiche survivante hérite de tous les e-mails, noms et clés d'identité des
 * fiches absorbées, pour que la page de la personne montre bien l'ensemble de
 * ses adresses.
 */
export function mergeAuthorRecords(
  authors: Iterable<StoredAuthor>,
  aliases: ReadonlyMap<string, string>,
): Map<string, StoredAuthor> {
  const result = new Map<string, StoredAuthor>();
  const absorbed: StoredAuthor[] = [];

  for (const author of authors) {
    const canonical = resolveAuthorId(author.id, aliases);
    if (canonical === author.id) result.set(author.id, { ...author });
    else absorbed.push(author);
  }

  for (const author of absorbed) {
    const canonical = resolveAuthorId(author.id, aliases);
    const target = result.get(canonical);
    if (target === undefined) {
      // La cible n'existe pas (données partielles) : on promeut la fiche absorbée
      // plutôt que de perdre ses commits.
      result.set(canonical, { ...author, id: canonical, manual: true });
      continue;
    }
    target.identityKeys = [...new Set([...target.identityKeys, ...author.identityKeys])].sort();
    target.knownNames = [...new Set([...target.knownNames, ...author.knownNames])].sort();
    target.knownEmails = [...new Set([...target.knownEmails, ...author.knownEmails])].sort();
    // Un compte technique absorbé par une personne ne fait pas d'elle un robot.
    target.isBot = target.isBot && author.isBot;
    target.manual = true;
  }

  return result;
}

export type MergeKind = 'email' | 'name' | 'login';

export interface MergeSuggestion {
  authorIds: [string, string];
  kind: MergeKind;
  reason: string;
  /** 0 → 1. Au-dessus de 0.8, la proposition est mise en avant dans l'UI. */
  confidence: number;
}

/**
 * Propose des fusions sans jamais les appliquer.
 *
 * Indices retenus, par confiance décroissante :
 *  1. même partie locale sur deux domaines différents (`j.dupont@a.fr` / `j.dupont@b.com`) ;
 *  2. nom d'affichage identique après normalisation ;
 *  3. partie locale qui reconstitue le nom (`prenom.nom` ↔ « Prénom Nom »).
 */
export function suggestMerges(authors: StoredAuthor[]): MergeSuggestion[] {
  const suggestions: MergeSuggestion[] = [];
  const seen = new Map<string, MergeSuggestion>();

  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  const add = (
    a: StoredAuthor,
    b: StoredAuthor,
    kind: MergeKind,
    reason: string,
    confidence: number,
  ) => {
    if (a.id === b.id) return;
    const key = pairKey(a.id, b.id);
    // Un même couple peut être repéré par plusieurs indices : on garde le plus
    // fort plutôt que d'afficher deux fois la même proposition.
    const existing = seen.get(key);
    if (existing !== undefined) {
      if (confidence > existing.confidence) {
        existing.kind = kind;
        existing.reason = reason;
        existing.confidence = confidence;
      }
      return;
    }
    const suggestion: MergeSuggestion = { authorIds: [a.id, b.id], kind, reason, confidence };
    seen.set(key, suggestion);
    suggestions.push(suggestion);
  };

  const people = authors.filter((author) => !author.isBot);

  // --- Indice 1 : même partie locale d'e-mail sur deux domaines --------
  const byLocal = new Map<string, StoredAuthor[]>();
  for (const author of people) {
    const local = localPart(author.id);
    if (local.length < 3) continue;
    const bucket = byLocal.get(local);
    if (bucket) bucket.push(author);
    else byLocal.set(local, [author]);
  }
  for (const [local, group] of byLocal) {
    forEachPair(group, (a, b) =>
      add(a, b, 'email', `Même identifiant e-mail « ${local} » sur deux domaines`, 0.9),
    );
  }

  // --- Indice 2 : le nom affiché ---------------------------------------
  //
  // C'est le cas visé par « mail pro et mail perso, même nom » : les deux
  // adresses n'ont rien en commun, seul l'état civil les rapproche.
  //
  // Attention : deux personnes différentes PEUVENT porter le même nom. Ces
  // rapprochements restent donc des propositions, jamais des fusions d'office.
  const byName = new Map<string, StoredAuthor[]>();
  const bySortedName = new Map<string, StoredAuthor[]>();

  for (const author of people) {
    for (const variant of nameVariants(author)) {
      // On exige un nom composé : « admin », « dev » ou « build » rapprocheraient
      // n'importe qui.
      if (!variant.includes(' ')) continue;
      pushTo(byName, variant, author);
      // Clé insensible à l'ordre : « Rivière Amélie » rejoint « Amélie Rivière ».
      pushTo(bySortedName, variant.split(' ').sort().join(' '), author);
    }
  }

  for (const [, group] of byName) {
    forEachPair(group, (a, b) => add(a, b, 'name', `Même nom affiché « ${a.displayName} »`, 0.88));
  }
  for (const [, group] of bySortedName) {
    forEachPair(group, (a, b) =>
      add(a, b, 'name', `Mêmes nom et prénom, dans un ordre différent`, 0.82),
    );
  }

  // Initiale + patronyme : « A. Rivière » ↔ « Amélie Rivière ».
  for (const author of people) {
    const tokens = nameTokens(author.displayName);
    if (tokens.length < 2) continue;
    const surname = tokens[tokens.length - 1]!;
    const initial = tokens[0]![0]!;
    if (surname.length < 3) continue;

    for (const other of people) {
      if (other.id === author.id) continue;
      const otherTokens = nameTokens(other.displayName);
      if (otherTokens.length < 2) continue;
      const otherSurname = otherTokens[otherTokens.length - 1]!;
      if (otherSurname !== surname) continue;
      const otherInitial = otherTokens[0]![0]!;
      if (otherInitial !== initial) continue;
      // Au moins l'un des deux prénoms est abrégé, sinon l'indice 2 a déjà
      // tranché (même prénom complet) ou il s'agit d'homonymes distincts
      // (« Amélie Rivière » vs « Marc Rivière »).
      if (tokens[0]!.length > 1 && otherTokens[0]!.length > 1) continue;
      add(
        author,
        other,
        'name',
        `« ${other.displayName} » est probablement « ${author.displayName} » abrégé`,
        0.7,
      );
    }
  }

  // --- Indice 3 : la partie locale reconstitue le nom complet -----------
  for (const author of people) {
    const tokens = nameTokens(author.displayName).filter((token) => token.length >= 2);
    if (tokens.length < 2) continue;
    const joined = tokens.join('');
    const reversed = [...tokens].reverse().join('');
    const initialLast = `${tokens[0]![0]}${tokens.slice(1).join('')}`;

    for (const other of people) {
      if (other.id === author.id) continue;
      const local = localPart(other.id).replace(/[^a-z0-9]/g, '');
      if (local.length < 5) continue;
      if (local === joined || local === reversed || local === initialLast) {
        add(
          author,
          other,
          'login',
          `« ${localPart(other.id)} » correspond à « ${author.displayName} »`,
          0.75,
        );
      }
    }
  }

  return suggestions.sort(
    (a, b) => b.confidence - a.confidence || a.authorIds[0].localeCompare(b.authorIds[0]),
  );
}

/** Tokens normalisés d'un nom, particules françaises retirées. */
export function nameTokens(name: string): string[] {
  const PARTICLES = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'van', 'von', 'der', 'da', 'di']);
  return normalizeName(name)
    .split(' ')
    .filter((token) => token.length > 0 && !PARTICLES.has(token));
}

/**
 * Variantes normalisées sous lesquelles une personne peut être reconnue :
 * son nom affiché, mais aussi les autres noms croisés dans ses commits.
 */
function nameVariants(author: StoredAuthor): string[] {
  const variants = new Set<string>();
  for (const raw of [author.displayName, ...author.knownNames]) {
    const tokens = nameTokens(raw);
    if (tokens.length >= 2) variants.add(tokens.join(' '));
  }
  return [...variants];
}

function pushTo<K>(map: Map<K, StoredAuthor[]>, key: K, author: StoredAuthor): void {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [author]);
  else if (!bucket.some((entry) => entry.id === author.id)) bucket.push(author);
}

function forEachPair(group: StoredAuthor[], callback: (a: StoredAuthor, b: StoredAuthor) => void): void {
  if (group.length < 2) return;
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) callback(group[i]!, group[j]!);
  }
}

