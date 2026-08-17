# GitStats

Tableau de bord d'activité Git pour tout un parc GitLab, sur **une ou plusieurs
instances**. **100 % client** : aucun backend, aucun proxy. L'application tourne
dans le navigateur, appelle directement chaque API GitLab avec son Personal Access
Token, agrège et stocke les résultats en local.

```bash
npm install
npm run dev      # http://localhost:4300
```

## Ce que ça montre

- **Global** — KPI, calendrier d'activité, commits dans le temps par contributeur,
  volume de code ajouté/supprimé, répartition par dépôt.
- **Projets** — table triable des dépôts, puis fiche détaillée (timeline,
  contributeurs, derniers commits).
- **Personnes** — classement, fiche individuelle (répartition par dépôt, rythme
  horaire et hebdomadaire), et un **comparateur** de 2 à 5 personnes.
- **Réglages** — instances, fusion d'identités, dépôts en double, débit d'appels,
  fichier de données.

Métriques couvertes : **commits et lignes de code**. Ni MR, ni issues, ni CI.

## Plusieurs instances GitLab

L'écran d'accueil gère une **liste de couples URL / token** : ajout, retrait,
renommage. Chaque ajout est validé par un `GET /user` avant enregistrement, ce qui
affiche immédiatement le compte reconnu. Toutes les vues présentent ensuite le
**cumul** des instances.

Points structurants :

- **Les identifiants de projet GitLab sont des séquences propres à chaque serveur.**
  Le projet `42` de l'instance A n'a rien à voir avec celui de l'instance B. La clé
  interne est donc `${instanceId}~${gitlabId}` : sans elle, le planificateur
  retrouverait la fiche d'un projet d'une autre instance et conclurait
  « inchangé → zéro appel » sur un dépôt jamais vu.
- **Un limiteur de débit par instance.** Les quotas sont propres à chaque serveur :
  un 429 sur l'un ne bride pas les autres. Le réglage reste commun.
- **Les instances sont traitées en parallèle**, et un token expiré n'arrête que la
  sienne — les autres vont au bout, l'instance fautive est signalée dans les réglages.
- **Les personnes s'agrègent gratuitement.** `authorId` dérive de l'e-mail
  normalisé, donc indépendant de l'instance : quelqu'un présent sur deux serveurs
  avec la même adresse ne compte que pour une personne.
- **Sur une seule instance, l'interface est identique à avant** : le filtre
  « Instances » et les pastilles n'apparaissent qu'à partir de deux.

### Dépôts en double entre instances

Deux dépôts qui partagent un SHA de commit sont **forcément le même code** — un SHA
est un hachage de tout l'historique. La détection est donc certaine et quasi
gratuite (les SHA récents sont déjà stockés). Sans elle, un dépôt mirroré compte
deux fois et gonfle silencieusement commits, lignes et classements. Les groupes
détectés sont listés dans les réglages, avec exclusion en un clic. Deux dépôts
d'une **même** instance sont ignorés : c'est un fork légitime, pas un doublon.

## Faisabilité : ce qui a été vérifié, pas supposé

| Point | Résultat |
|---|---|
| CORS sur une instance GitLab auto-hébergée | ✅ `access-control-allow-origin: *`, preflight `OPTIONS` + `PRIVATE-TOKEN` → **200**. Zéro backend nécessaire. |
| Écriture de 30 000 seaux dans IndexedDB | ⚠️ 24 s avec trois index sur le magasin `daily`. Deux n'étaient jamais interrogés : supprimés + écriture par lots ⇒ **9 s**. |
| Headers de pagination lisibles depuis le navigateur | ✅ `Link`, `X-Total`, `X-Total-Pages`, `X-Next-Page`, `ETag` sont exposés. |
| Headers `RateLimit-*` / `Retry-After` | ❌ **non exposés** au JS cross-origin → le débit doit s'auto-réguler (voir plus bas). |
| `X-Total-Pages` sur l'API commits | ❌ non renvoyé par GitLab (choix de perf) → pagination via `Link rel="next"`. |

## Comment le coût en appels est tenu

Sur 234 dépôts, la collecte se fait en trois vagues :

| Vague | Endpoint | Coût |
|---|---|---|
| 0 — Découverte | `GET /projects?membership=true&simple=true` | ~3 appels |
| 1 — Aperçu | `GET /projects/:id/repository/contributors` | 1 / dépôt |
| 2 — Historique | `GET /projects/:id/repository/commits?since=…&with_stats=true` | N / dépôt |

**Le levier principal est `last_activity_at`**, qui arrive gratuitement dans la
liste des projets : si un dépôt n'a pas bougé depuis le dernier passage, il coûte
**zéro appel**.

| | Appels | Durée @400 req/min |
|---|---|---|
| 1ᵉʳ sync (234 dépôts, 12 mois) | ~1 200 – 2 700 | 3 à 7 min |
| Syncs suivants (~30 dépôts actifs) | ~50 – 100 | < 30 s |

Élargir la fenêtre (12 → 24 mois) ne re-télécharge que la période manquante.

### Régulation du débit

Les en-têtes `RateLimit-*` de GitLab étant invisibles depuis un navigateur, le
limiteur se calibre seul sur le seul signal observable, le code **429** :
token bucket + AIMD (débit divisé par 2 sur incident, remontée additive ensuite),
backoff exponentiel avec *full jitter*, et pause/reprise/annulation réelles.
Réglable dans l'écran Réglages.

## Décisions qui changent les chiffres

Trois choix affectent directement ce qui s'affiche. Ils sont volontaires.

1. **Les lignes d'un commit de merge ne sont jamais comptées.** GitLab calcule
   `stats` comme le diff face au premier parent : pour un merge de branche, cela
   renvoie l'intégralité des modifications déjà comptées commit par commit. Les
   inclure doublerait le volume de tout dépôt qui merge ses branches. Le commit
   de merge reste compté dans `commits`, mais pèse zéro ligne.

2. **L'activité est datée sur `authored_date`**, pas `committed_date` — quand le
   travail a été fait, plutôt que quand un rebase l'a réécrit. Le curseur
   d'incrémental, lui, suit `committed_date`, seule date filtrée par l'API.

3. **Les identités ne sont jamais fusionnées automatiquement** au-delà de
   l'e-mail normalisé. Rattacher à tort deux personnes fausse durablement toutes
   les comparaisons sans que rien ne le signale ; les rapprochements probables
   sont proposés dans les réglages et attendent une validation.

### Rapprochement des identités

Une même personne apparaît souvent plusieurs fois : adresse pro, adresse perso,
e-mail `noreply`, nom saisi différemment. L'écran **Réglages → Identités** propose
des rapprochements groupés par type d'indice :

| Indice | Exemple | Confiance |
|---|---|---|
| Même identifiant e-mail sur deux domaines | `a.riviere@example.com` ↔ `a.riviere@example.org` | 0,90 |
| **Même nom affiché** | `Amélie Rivière <…@example.com>` ↔ `Amelie RIVIERE <…@example.net>` | 0,88 |
| **Mêmes nom et prénom, ordre inversé** | `Sophie Bernard` ↔ `BERNARD Sophie` | 0,82 |
| Login reconstituant le nom | `amelie.riviere@…` ↔ « Amélie Rivière » | 0,75 |
| **Prénom abrégé** | `A. Rivière` ↔ `Amélie Rivière` | 0,70 |

Le rapprochement par nom compare les formes normalisées (accents, casse et
ponctuation ignorés, particules retirées) et s'appuie aussi sur les autres noms
croisés dans les commits de la personne.

Deux garde-fous délibérés :

- **Rien n'est fusionné sans validation.** Deux personnes peuvent porter le même
  nom ; l'interface le rappelle sur ce groupe d'indices.
- **Un patronyme partagé ne suffit jamais** : `Amélie Rivière` et `Marc Rivière`
  ne sont pas rapprochés, et un nom en un seul mot (`admin`, `dev`) est ignoré.

Pour les cas qu'aucun indice ne repère — surnom, nom marital, faute de frappe —
un **rapprochement manuel** permet de désigner deux personnes et de choisir
laquelle conserver.

Les fusions sont **résolues à la lecture** : elles s'appliquent immédiatement,
sans re-synchroniser, et restent annulables — les seaux stockés conservent
l'identifiant d'origine.

### Angle mort connu

Le mode incrémental repart **7 jours** en arrière. Un commit ancien arrivé par le
merge d'une branche plus vieille que ça n'est pas rattrapé. Le bouton **« Tout
resynchroniser »** (Réglages) est le seul moyen sûr de le récupérer.

## Stockage

Les commits bruts ne sont **jamais** archivés : l'agrégation en seaux
`(projet, auteur, jour)` se fait à l'ingestion. Sur 234 dépôts et 12 mois, le brut
pèserait des centaines de Mo pour aucune analyse supplémentaire.

- **IndexedDB** pour la vitesse et la durabilité locale. Le magasin `daily` ne
  porte **qu'un seul index** (`by-project`) : les filtres par auteur et par date
  s'exécutent en mémoire, et chaque index superflu se paie à l'écriture.
- **Fichier `.json` lié** (File System Access API, Chrome/Edge) réécrit
  automatiquement pendant les syncs. Repli export/import manuel ailleurs.
- **Les tokens ne sont jamais écrits** ni dans IndexedDB, ni dans le `.json` : ils
  vivent en `sessionStorage` (ou `localStorage` sur choix explicite), indexés par
  instance. Le fichier de données peut donc être partagé sans risque.

### Migration depuis la version mono-instance

Le passage au multi-instance change les clés de projet. La montée de schéma
IndexedDB (v1 → v2) **convertit les données existantes** plutôt que de les jeter :
chaque projet est rattaché à l'instance d'origine, déduite de l'ancienne
configuration. Les fusions manuelles d'identités sont préservées. Les fichiers
`.json` au format v1 sont acceptés à l'import et convertis de la même façon.

## Développement

```bash
npm run dev          # serveur de développement
npm test             # 185 tests
npm run lint         # typecheck strict
npm run build        # build de production (statique, déployable tel quel)

npm run demo:data    # jeu de démo réaliste (2 instances, 234 dépôts, 12 mois, 1 miroir)
npm run screenshots  # capture les écrans + vérifie l'absence d'erreur console
```

`npm run demo:data` produit un fichier importable depuis l'écran d'accueil : il
permet de travailler l'interface sans token et sans solliciter GitLab.

### Organisation

```
src/
  gitlab/     client, limiteur AIMD, pagination, endpoints   ← aucun import React
  sync/       coordinateur multi-instances, moteur 3 vagues, planificateur,
              agrégation, identités, détection de miroirs   ← idem
  store/      IndexedDB (+ migration v1→v2), dataset en mémoire, fichier .json,
              stores Zustand
  query/      filtres, agrégations, granularité temporelle
  viz/        attribution des couleurs de série
  components/ primitives, graphiques ECharts, tableau
  routes/     écrans
```

`gitlab/` et `sync/` sont volontairement sans dépendance React : le moteur peut
être déplacé dans un Web Worker sans réécriture si l'interface saccade pendant
une collecte.
