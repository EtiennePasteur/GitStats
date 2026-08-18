/**
 * Génère un fichier de données GitStats réaliste, sans toucher à GitLab.
 *
 * Sert à travailler l'interface (et à la relire à l'œil) sur un volume
 * représentatif — 234 dépôts, 12 mois — sans dépendre d'un token ni saturer
 * l'instance à chaque itération de style.
 *
 *   node scripts/make-demo-data.mjs [chemin-de-sortie]
 */

import { writeFileSync } from 'node:fs';

const OUT = process.argv[2] ?? 'demo-gitstats.json';

const PROJECT_COUNT = 234;
const MONTHS = 12;

// Deux instances, pour exercer l'agrégation multi-serveurs. La seconde est plus
// petite, comme un GitLab d'équipe à côté du GitLab principal.
const INSTANCES = [
  { id: 'gitlab-example-com', host: 'https://gitlab.example.com', label: 'principal', share: 0.8 },
  { id: 'gitlab-example-org', host: 'https://gitlab.example.org', label: 'secondaire', share: 0.2 },
];
const projectKey = (instanceId, gitlabId) => `${instanceId}~${gitlabId}`;

const GROUPS = [
  'backend/api',
  'backend/services',
  'frontend/web',
  'frontend/mobile',
  'data/etl',
  'data/ml',
  'infra/terraform',
  'infra/k8s',
  'tools',
  'docs',
];

// Personnes fictives sur les domaines réservés par la RFC 2606 (`example.*`),
// qui ne peuvent être attribués à aucune organisation réelle.
const PEOPLE = [
  ['Amélie Rivière', 'a.riviere@example.com'],
  ['Marie Durand', 'm.durand@example.com'],
  ['Paul Martin', 'p.martin@example.com'],
  ['Sophie Bernard', 's.bernard@example.com'],
  ['Lucas Petit', 'l.petit@example.com'],
  ['Camille Roux', 'c.roux@example.com'],
  ['Thomas Moreau', 't.moreau@example.com'],
  ['Julie Simon', 'j.simon@example.com'],
  ['Nicolas Laurent', 'n.laurent@example.com'],
  ['Aurélie Michel', 'a.michel@example.com'],
  ['Karim Benali', 'k.benali@example.com'],
  ['Hélène Girard', 'h.girard@example.com'],
  ['Vincent Bonnet', 'v.bonnet@example.com'],
  ['Sarah Dupont', 's.dupont@example.com'],
  ['Mathieu Leroy', 'm.leroy@example.com'],
  ['Claire Fontaine', 'c.fontaine@example.com'],
  ['Olivier Mercier', 'o.mercier@example.com'],
  ['Nadia Cherif', 'n.cherif@example.com'],
  ['GitLab CI', 'gitlab-ci@example.com'],
  ['Renovate Bot', 'renovate-bot@example.com'],
];

// Générateur déterministe : deux exécutions donnent le même fichier, donc les
// captures d'écran restent comparables d'une itération à l'autre.
let seed = 20260817;
function random() {
  seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
  return seed / 4_294_967_296;
}
const pick = (list) => list[Math.floor(random() * list.length)];
const between = (min, max) => min + Math.floor(random() * (max - min + 1));

const END = new Date('2026-08-17T12:00:00.000Z');
const START = new Date(END);
START.setMonth(START.getMonth() - MONTHS);

const days = [];
for (let d = new Date(START); d <= END; d.setUTCDate(d.getUTCDate() + 1)) {
  days.push(d.toISOString().slice(0, 10));
}

const authors = PEOPLE.map(([displayName, email]) => ({
  id: email,
  displayName,
  primaryEmail: email,
  identityKeys: [email],
  knownNames: [displayName],
  knownEmails: [email],
  isBot: /bot|gitlab-ci/.test(email),
}));

// Identités en double, pour que l'écran de fusion ait de quoi travailler :
// un login qui reconstitue le nom, un mail perso au même état civil, et un
// prénom abrégé.
for (const [id, displayName] of [
  ['amelie.riviere@example.net', 'Amelie R'],
  ['ariviere@example.org', 'Amélie Rivière'],
  ['m.durand@example.net', 'M. Durand'],
  ['bernard.sophie@example.org', 'BERNARD Sophie'],
]) {
  authors.push({
    id,
    displayName,
    primaryEmail: id,
    identityKeys: [id],
    knownNames: [displayName],
    knownEmails: [id],
    isBot: false,
  });
}

const authorIndex = authors.map((a) => a.id);
const indexOf = new Map(authorIndex.map((id, i) => [id, i]));

const projects = [];
const daily = [];
const recentCommits = [];

/**
 * Loi horaire propre à chaque personne : sans cela, toutes les fiches montrent
 * le même graphe de rythme et la capture publiée illustre mal la carte.
 * `[début, fin, part]` — le reste des commits tombe dans la queue de soirée.
 */
const HOUR_PROFILES = [
  [9, 18, 0.85], // journée classique
  [7, 15, 0.9], // lève-tôt
  [13, 22, 0.8], // tardif
];
const profileOf = new Map(authorIndex.map((id, i) => [id, HOUR_PROFILES[i % HOUR_PROFILES.length]]));

/** Tire `count` heures selon la loi de l'auteur, agrégées en paires triées. */
function drawHours(authorId, count) {
  const [start, end, share] = profileOf.get(authorId) ?? HOUR_PROFILES[0];
  const byHour = new Map();
  for (let i = 0; i < count; i++) {
    const hour = random() < share ? between(start, end) : between(19, 23);
    byHour.set(hour, (byHour.get(hour) ?? 0) + 1);
  }
  const packed = [];
  for (const hour of [...byHour.keys()].sort((a, b) => a - b)) packed.push(hour, byHour.get(hour));
  return packed;
}

for (let id = 1; id <= PROJECT_COUNT; id++) {
  // Les identifiants numériques repartent de 1 sur chaque instance : c'est
  // exactement la collision que la clé préfixée doit absorber.
  const instance = id <= Math.round(PROJECT_COUNT * INSTANCES[0].share) ? INSTANCES[0] : INSTANCES[1];
  const gitlabId = instance === INSTANCES[0] ? id : id - Math.round(PROJECT_COUNT * INSTANCES[0].share);
  const key = projectKey(instance.id, gitlabId);
  const group = pick(GROUPS);
  const name = `${pick(['api', 'front', 'batch', 'lib', 'worker', 'gateway', 'sdk', 'admin'])}-${id}`;
  const path = `${group}/${name}`;

  // Distribution très asymétrique, comme un vrai parc : quelques dépôts
  // concentrent l'essentiel de l'activité, beaucoup sont quasi dormants.
  const intensity = random() < 0.12 ? between(8, 25) : random() < 0.4 ? between(2, 6) : between(0, 1);
  const team = Array.from({ length: between(1, 6) }, () => pick(authors).id);

  let commitCount = 0;
  let lastDay = null;

  for (const day of days) {
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    // Creux de week-end, sinon le calendrier n'a aucune texture.
    const factor = weekday === 0 || weekday === 6 ? 0.12 : 1;
    if (random() > 0.28 * factor) continue;

    for (const authorId of team) {
      const commits = Math.round(random() * intensity * factor);
      if (commits <= 0) continue;
      const additions = commits * between(8, 90);
      const deletions = Math.round(additions * (0.2 + random() * 0.6));
      const merges = random() < 0.15 ? 1 : 0;

      // La répartition horaire vit dans le seau. Invariants attendus par le
      // lecteur : somme(hourly) === commits, et hourlyMerges ⊆ hourly. Le
      // sous-ensemble se prend sur la première heure, borné par ce qu'elle
      // contient : un merge posé sur une heure qui n'a qu'un commit ferait
      // passer la soustraction du filtre « Masquer les merges » sous zéro.
      const hourly = drawHours(authorId, commits);
      const hourlyMerges = merges > 0 ? [hourly[0], Math.min(hourly[1], merges)] : [];

      daily.push([
        key,
        indexOf.get(authorId),
        day,
        commits,
        additions,
        deletions,
        merges,
        hourly,
        hourlyMerges,
      ]);
      commitCount += commits;
      lastDay = day;
    }
  }

  if (lastDay !== null) {
    for (let k = 0; k < Math.min(12, commitCount); k++) {
      const authorId = pick(team);
      recentCommits.push({
        key: `${key}|demo-${id}-${k}`,
        projectKey: key,
        sha: `demo-${id}-${k}`,
        shortSha: `d${id}${k}`.padEnd(7, '0').slice(0, 7),
        authorId,
        date: `${lastDay}T${String(between(9, 18)).padStart(2, '0')}:12:00.000Z`,
        title: pick([
          'feat: ajout du filtre par période',
          'fix: correction du calcul de TVA',
          'refactor: extraction du service de cache',
          'chore: montée de version des dépendances',
          'test: couverture du parcours de souscription',
          'docs: mise à jour du README',
        ]),
        additions: between(3, 240),
        deletions: between(0, 120),
        isMerge: false,
        webUrl: `${instance.host}/${path}/-/commit/demo-${id}-${k}`,
      });
    }
  }

  const lastActivity = lastDay !== null ? `${lastDay}T17:00:00.000Z` : START.toISOString();
  projects.push({
    key,
    gitlabId,
    instanceId: instance.id,
    name,
    nameWithNamespace: `${group} / ${name}`,
    pathWithNamespace: path,
    namespaceFullPath: group,
    defaultBranch: 'main',
    webUrl: `${instance.host}/${path}`,
    avatarUrl: null,
    createdAt: '2023-01-01T00:00:00.000Z',
    archived: false,
    lastActivityAt: lastActivity,
    sync: {
      state: commitCount > 0 ? 'done' : 'empty',
      coveredFrom: START.toISOString(),
      coveredUntil: END.toISOString(),
      syncedActivityAt: lastActivity,
      lastSyncedAt: END.toISOString(),
      commitCount,
      recentShas: [],
      hasOverview: true,
      error: null,
      currentPage: 0,
      fingerprint: 'stats=1;branches=default',
    },
  });
}

// Un dépôt mirroré entre les deux instances : mêmes SHA de commits des deux
// côtés, pour que l'écran de détection ait un cas réel à proposer.
const source = projects.find((p) => p.instanceId === INSTANCES[0].id && p.sync.commitCount > 0);
const mirror = projects.find((p) => p.instanceId === INSTANCES[1].id && p.sync.commitCount > 0);
if (source && mirror) {
  const sourceCommits = recentCommits.filter((c) => c.projectKey === source.key);
  for (const commit of recentCommits.filter((c) => c.projectKey === mirror.key)) {
    const index = recentCommits.indexOf(commit);
    if (index >= 0) recentCommits.splice(index, 1);
  }
  for (const commit of sourceCommits) {
    recentCommits.push({ ...commit, key: `${mirror.key}|${commit.sha}`, projectKey: mirror.key });
  }
  mirror.name = `${source.name}-mirror`;
  mirror.pathWithNamespace = `${mirror.namespaceFullPath}/${mirror.name}`;
}

// Un dépôt de configuration très actif, retiré des statistiques : le cas type de
// l'option « Ignorer » — tout le monde le touche, personne n'y produit de valeur
// mesurable, et sa présence écrase les classements.
const shared = projects
  .filter((p) => p !== source && p !== mirror && p.sync.commitCount > 0)
  .sort((a, b) => b.sync.commitCount - a.sync.commitCount)[0];
if (shared) {
  shared.name = 'config-partagee';
  shared.pathWithNamespace = `${shared.namespaceFullPath}/${shared.name}`;
  shared.nameWithNamespace = `${shared.namespaceFullPath} / ${shared.name}`;
  shared.muted = true;
}

const file = {
  format: 'gitstats',
  version: 1,
  instances: INSTANCES.map(({ id, host, label }) => ({
    id,
    host,
    label,
    user: { id: 1, username: 'ariviere', name: 'Amélie Rivière' },
    addedAt: START.toISOString(),
    authError: null,
  })),
  generatedAt: END.toISOString(),
  window: { from: START.toISOString(), until: END.toISOString() },
  config: {
    windowMonths: 12,
    membership: true,
    includeArchived: false,
    allBranches: false,
    withStats: true,
    requestsPerMinute: 400,
    maxConcurrent: 6,
    excludeBots: true,
    excludeMerges: false,
    botPatterns: ['bot', 'jenkins', 'gitlab-ci', 'sonarqube', 'renovate', 'dependabot', 'noreply', 'service-account', 'svc_'],
  },
  manualAliases: {},
  projects,
  authors,
  authorIndex,
  projectIndex: [...new Set(daily.map((row) => row[0]))],
  daily: [],
  overviews: [],
  recentCommits,
};

// Packing final : les clés de projet sont indexées comme les auteurs.
const projectIndexOf = new Map(file.projectIndex.map((key, i) => [key, i]));
file.daily = daily.map((row) => [
  projectIndexOf.get(row[0]),
  row[1],
  row[2],
  row[3],
  row[4],
  row[5],
  row[6],
  row[7],
  row[8],
]);

const json = JSON.stringify(file);
writeFileSync(OUT, json);
console.log(
  `${OUT} — ${INSTANCES.length} instances, ${projects.length} dépôts, ${authors.length} contributeurs, ` +
    `${daily.length.toLocaleString('fr-FR')} seaux, ${(json.length / 1024 / 1024).toFixed(1)} Mo`,
);
