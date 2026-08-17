/**
 * Détection des dépôts mirrorés entre instances.
 *
 * Deux dépôts qui partagent un SHA de commit sont FORCÉMENT le même code : un
 * SHA est un hachage du contenu, de l'arbre et de tout l'historique parent. Ce
 * n'est donc pas une heuristique mais une preuve, et la donnée est déjà là —
 * `recentCommits` conserve 100 commits par dépôt.
 *
 * Sans cette détection, un dépôt mirroré compte deux fois : commits, lignes et
 * classements sont gonflés sans que rien ne l'indique.
 *
 * On ne compare QUE des dépôts d'instances différentes : deux dépôts partageant
 * des commits au sein d'une même instance sont un fork ou une scission, c'est-à-dire
 * deux projets légitimes que l'utilisateur suit sciemment.
 */

import type { ProjectKey, StoredProject } from '../model/types';
import { instanceOfProject } from '../model/types';

export interface MirrorGroup {
  /** Clés des dépôts partageant du code, triées. */
  projectKeys: ProjectKey[];
  /** Nombre de SHA communs — plus il est élevé, plus les dépôts sont synchrones. */
  sharedShaCount: number;
  /** Instances concernées. */
  instanceIds: string[];
}

export function detectMirrors(
  projects: Iterable<StoredProject>,
  shasByProject: ReadonlyMap<ProjectKey, readonly string[]>,
): MirrorGroup[] {
  const known = new Map<ProjectKey, StoredProject>();
  for (const project of projects) known.set(project.key, project);

  // Index inversé : un seul balayage, pas de comparaison deux à deux (qui ferait
  // 234² paires sur un parc réaliste).
  const bySha = new Map<string, ProjectKey[]>();
  for (const [key, shas] of shasByProject) {
    if (!known.has(key)) continue;
    for (const sha of shas) {
      const bucket = bySha.get(sha);
      if (bucket === undefined) bySha.set(sha, [key]);
      else if (!bucket.includes(key)) bucket.push(key);
    }
  }

  /** Nombre de SHA partagés par couple de dépôts. */
  const pairs = new Map<string, { keys: [ProjectKey, ProjectKey]; count: number }>();
  for (const keys of bySha.values()) {
    if (keys.length < 2) continue;
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const a = keys[i]!;
        const b = keys[j]!;
        // Deux dépôts d'une même instance : fork assumé, pas un miroir.
        if (instanceOfProject(a) === instanceOfProject(b)) continue;
        const [first, second] = a < b ? [a, b] : [b, a];
        const id = `${first}|${second}`;
        const existing = pairs.get(id);
        if (existing === undefined) pairs.set(id, { keys: [first, second], count: 1 });
        else existing.count += 1;
      }
    }
  }

  // Fusion transitive : A miroir de B, B miroir de C ⇒ un seul groupe {A, B, C}.
  const parent = new Map<ProjectKey, ProjectKey>();
  const find = (key: ProjectKey): ProjectKey => {
    let root = key;
    while (parent.get(root) !== undefined && parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const union = (a: ProjectKey, b: ProjectKey): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent.set(rootB, rootA);
  };

  const counts = new Map<ProjectKey, number>();
  for (const { keys, count } of pairs.values()) {
    parent.set(keys[0], parent.get(keys[0]) ?? keys[0]);
    parent.set(keys[1], parent.get(keys[1]) ?? keys[1]);
    union(keys[0], keys[1]);
    counts.set(find(keys[0]), (counts.get(find(keys[0])) ?? 0) + count);
  }

  const groups = new Map<ProjectKey, Set<ProjectKey>>();
  for (const key of parent.keys()) {
    const root = find(key);
    const group = groups.get(root);
    if (group === undefined) groups.set(root, new Set([key]));
    else group.add(key);
  }

  return [...groups.entries()]
    .map(([root, members]) => {
      const projectKeys = [...members].sort();
      return {
        projectKeys,
        sharedShaCount: counts.get(root) ?? 0,
        instanceIds: [...new Set(projectKeys.map(instanceOfProject))].sort(),
      } satisfies MirrorGroup;
    })
    .filter((group) => group.projectKeys.length > 1)
    .sort((a, b) => b.sharedShaCount - a.sharedShaCount);
}

/**
 * Dépôts à écarter pour ne compter chaque code qu'une fois.
 * On conserve celui qui a le plus de commits — en général l'instance d'origine,
 * le miroir étant souvent partiel.
 */
export function suggestExclusions(
  groups: MirrorGroup[],
  commitsByProject: ReadonlyMap<ProjectKey, number>,
): ProjectKey[] {
  const excluded: ProjectKey[] = [];
  for (const group of groups) {
    const ranked = [...group.projectKeys].sort(
      (a, b) => (commitsByProject.get(b) ?? 0) - (commitsByProject.get(a) ?? 0) || a.localeCompare(b),
    );
    excluded.push(...ranked.slice(1));
  }
  return excluded;
}
