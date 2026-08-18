# GitStats — notes de reprise

Tableau de bord d'activité Git multi-instances GitLab. **100 % client** : aucun
backend, aucun proxy. Le navigateur appelle directement chaque API GitLab avec son
Personal Access Token, agrège, et stocke en IndexedDB.

```bash
npm run dev          # http://localhost:4300/GitStats/ (base GitHub Pages)
npm test             # 225 tests, ~0,8 s
npm run lint         # tsc -b --noEmit (strict, noUncheckedIndexedAccess)
npm run build
npm run demo:data    # jeu de démo → demo-gitstats.json (2 instances, 234 dépôts, 1 miroir)
npm run screenshots  # capture les écrans + détecte les erreurs console
npm run shots:readme # régénère docs/screenshots/ (les captures publiées)
```

---

## Contraintes non négociables

- **Aucun backend.** Toute solution qui suppose un serveur, un proxy ou une clé
  côté serveur est hors sujet.
- **`gitlab/` et `sync/` n'importent JAMAIS React.** Le moteur doit rester
  déplaçable dans un Web Worker sans réécriture.
- **Aucune référence identifiante** (employeur, hôtes internes, collègues). Les
  fixtures utilisent les domaines réservés RFC 2606 : `example.com` / `.org` /
  `.net`. Personne de référence dans les tests : **Amélie Rivière**
  (`a.riviere@example.com`).
- Commentaires, UI et intitulés de tests **en français**. Les commentaires
  expliquent le *pourquoi*, jamais le *quoi*.

---

## Faits sur l'API GitLab (vérifiés, ne pas re-supposer)

| Fait | Conséquence dans le code |
|---|---|
| `/api/v4/*` renvoie `access-control-allow-origin: *`, préflight `OPTIONS` + `PRIVATE-TOKEN` → 200 | Le 100 % front est possible sans proxy |
| `RateLimit-*` et `Retry-After` **ne sont PAS** dans `Access-Control-Expose-Headers` | Impossible de piloter le débit dessus → limiteur AIMD auto-calibré sur les 429 (`gitlab/rateLimiter.ts`) |
| L'API commits ne renvoie ni `X-Total` ni `X-Total-Pages` | Pagination par `Link rel="next"` / `X-Next-Page` uniquement |
| `Link`, `X-Total`, `X-Total-Pages`, `X-Next-Page`, `ETag` **sont** exposés | Progression exacte dès la 1ʳᵉ page sur `/projects` |
| `per_page` plafonne à 100 | `paginate.ts` le force |

---

## Les pièges — à lire avant de toucher au calcul

Chacun a coûté un vrai bug. Ils sont contre-intuitifs : ne pas les « corriger ».

### Identité des projets
Les IDs de projet GitLab sont des **séquences par serveur** : le projet 42 de
l'instance A n'a rien à voir avec celui de B. L'identité interne est
`ProjectKey = ${instanceId}~${gitlabId}`.
- `gitlabId` ne sert **qu'aux appels API**, jamais comme identité.
- Le séparateur est `~` parce qu'il est non réservé en URL et traverse la route
  `/projets/:key` du routeur à hash. `#` ou `:` casseraient.
- `planSync` ne doit recevoir **que les projets de son instance**, sinon il conclut
  « inchangé → zéro appel » sur un dépôt jamais vu.

### Lignes de code
Les lignes d'un **commit de merge sont exclues à l'ingestion**
(`sync/aggregate.ts`). GitLab calcule `stats` comme le diff face au premier
parent : pour un merge de branche il renvoie tout le travail déjà compté commit
par commit. Les inclure double le volume de tout dépôt qui merge.

### Dates
- Bucketing sur **`authored_date`** (quand le travail a été fait).
- Curseur d'incrémental sur **`committed_date`** (seule date filtrée par
  `since`/`until`). Mélanger les deux crée des trous ou des doublons.
- Le jour local se lit en **découpant la chaîne ISO** (`iso.slice(0,10)`), jamais
  via `new Date().toISOString()` qui décale d'un jour les commits de soirée.

### Incrémental
- Le levier d'économie est `last_activity_at`, gratuit dans la liste des projets.
  234 dépôts → ~2 000 appels au 1ᵉʳ sync, **< 100 aux suivants**.
- `OVERLAP_DAYS = 7` (`model/types.ts`) est utilisé **à deux endroits** qui doivent
  rester cohérents : borne basse des requêtes incrémentales *et* fenêtre de SHA
  mémorisés pour la dédup. Raccourcir la seconde ⇒ double comptage silencieux.
- Angle mort assumé : une branche mergée après > 7 jours de vie. Seul remède, le
  bouton « Tout resynchroniser » (`config.forceFullResync`).

### Dépôts écartés — deux notions à ne pas fusionner
Deux drapeaux cohabitent sur `StoredProject`, et les confondre réintroduit un bug
que la détection de miroirs existe pour éviter :
- `excluded` — **structurel**. Un dépôt mirroré entre instances ; le compter deux
  fois gonfle commits, lignes et classements. Écarté **inconditionnellement** dans
  `filterBuckets`, jamais réversible par un filtre.
- `muted` — **éditorial**. Choix de l'utilisateur (le dépôt de config que toute
  l'équipe touche). Réversible d'un clic via `Filters.excludeMuted`, piloté par
  l'interrupteur « Masquer les dépôts ignorés » de la barre de filtres.

Les deux sont préservés par le sync (`engine.ts`, `previous?.…`) : sans quoi
chaque re-découverte du dépôt effacerait la décision.

Conséquence UI : un dépôt ignoré n'a plus de seau, donc plus de ligne dans la
route Projets. L'inventaire exhaustif est la carte « Dépôts ignorés » des
Réglages ; la fiche d'un dépôt, elle, appelle `useAnalytics({ includeMuted: true })`
— son périmètre étant unique, aucun total ne peut y être gonflé.

### Agrégation
- `activeDays` compte les **jours distincts**, pas les seaux. Il y a un seau par
  (projet, auteur, jour) : sommer les seaux donne « 1 796 jours actifs » sur 365.

### Rythme de travail — heures dans le seau
La répartition horaire est portée par `DailyBucket.hourly` (paires `[heure,
commits]` triées, `model/hours.ts`), et non par un magasin à part. Ce qui en
dépend :
- `somme(hourly) ≤ commits` est un **invariant**, y compris après filtrage :
  `filterBuckets` retranche `hourlyMerges` quand les merges sont masqués, sinon
  le total du graphe dépasserait le KPI « Commits » de la même page.
  `hourlyMerges` est un **sous-ensemble** de `hourly`, jamais un complément.
- `undefined` ≠ `[]`. `undefined` = heure inconnue (seau collecté avant
  l'introduction du champ, irrécupérable sans `forceFullResync`) ; c'est le seul
  marqueur de couverture, et il doit survivre à l'aller-retour `.json` — d'où les
  lignes de longueur 7 conservées telles quelles par `serialize.ts`.
- Le **jour de la semaine ne se stocke pas** : `localWeekday(bucket.day)` le
  déduit. Il est donc exact sur 100 % du périmètre, là où les heures ne couvrent
  que les seaux collectés depuis. `rhythmFromBuckets` renvoie `known`/`total`
  pour que la carte dise sa couverture au lieu de la taire.
- L'ancienne forme `AuthorRhythm` (24 + 7 compteurs par auteur) est **dépréciée** :
  sans date ni dépôt, elle ignorait toute la barre de filtres, comptait double les
  dépôts mirrorés, et un re-sync complet doublait ses compteurs faute de pouvoir
  en retirer la part d'un dépôt. Son magasin IndexedDB reste **déclaré mais vide** :
  le bloc `upgrade` de `store/db.ts` est gardé par `oldVersion >= 1` sans borne
  haute, donc une version 3 du schéma rejouerait la migration v1→v2 sur une base
  v2 et détruirait les données. Resserrer ce garde-fou avant de le supprimer.

### Identités des personnes
- `authorId` dérive de l'e-mail normalisé ⇒ **indépendant de l'instance**.
  L'agrégation cross-instances d'une même personne est donc gratuite.
- Fusion **automatique** uniquement sur e-mail identique. Le reste est **suggéré**
  (`suggestMerges`) et attend validation : fusionner deux homonymes à tort fausse
  durablement les comparaisons sans que rien ne le signale.
- Les fusions sont **résolues à la lecture** (`filterBuckets(…, aliases)`) : effet
  immédiat et réversible. Ne jamais réécrire les seaux.

### Sync multi-instances
- `db.replaceAuthors()` **remplace tout le magasin**. Seul le `SyncCoordinator`
  a le droit de l'appeler ; un moteur qui le ferait effacerait les auteurs des
  autres instances.
- Le `IdentityResolver` est **partagé** entre instances, injecté par le
  coordinateur.
- **Un `RateLimiter` par instance** : les quotas sont per-serveur.
- Un token expiré n'arrête que son instance (`instance.authError`).

### IndexedDB
- Le magasin `daily` ne porte **qu'un seul index** (`by-project`). Les filtres par
  auteur et par date tournent en mémoire (< 100 ms sur 150 000 seaux). Deux index
  superflus coûtaient **15 s sur un import de 30 000 seaux** (24 s → 9 s après
  suppression + écriture par lots de 2 000).
- Schéma v2. La migration v1→v2 (`store/migrate.ts`) **convertit** les données au
  lieu de les jeter ; `migrateV1ToV2` est pure et testée.
- On n'archive **jamais** les commits bruts, seulement les seaux journaliers et
  les 100 derniers commits par dépôt.

---

## Règles de dataviz

Invoquer la skill **`dataviz`** avant d'écrire du code de graphique.
Contraintes déjà appliquées, à ne pas casser :

- Palette validée au script (8/8 PASS sur surface sombre). Tokens dans
  `styles/index.css`, accès via `viz/palette.ts`.
- **La couleur suit l'entité, jamais le rang.** L'attribution se calcule sur le
  classement *non filtré* : changer la plage de dates ne doit repeindre personne.
- Au-delà de 8 séries → « Autres », jamais une 9ᵉ teinte générée. La série
  « Autres » est renvoyée **en tête** pour se placer au bas de la pile.
- L'empilement est réservé aux lectures de **composition** (Global, Projets,
  Personnes). Comparer trace des **courbes non empilées** (`stacked={false}`) :
  empilées, deux bandes ne se comparent pas, la hauteur de l'une dépendant de
  celles posées en dessous.
- Un seul axe des ordonnées. Jamais de double échelle.
- Agrégation temporelle automatique (`pickGranularity`) au-delà de 92 jours, et
  les seaux de bord partiels sont **rognés pour l'affichage uniquement** — les
  KPI et tableaux comptent tout.

---

## Vérification

`npm test` ne suffit pas. **Trois bugs réels ne sont apparus qu'en ouvrant
l'app** : `useNavigate()` hors Router (écran d'accueil mort), `activeDays` à 1 796,
et les 24 s de blocage à l'import.

```bash
npm run demo:data && npm run dev      # dans un terminal
npm run screenshots                    # dans un autre
```

`screenshot.mjs` utilise `playwright-core` (devDependency) avec le Chrome système ;
surchargeable par `CHROME_PATH`. Il échoue si une erreur console apparaît.

Contrôle anti-fuite avant toute livraison :

```bash
grep -rniE "<termes identifiants>" --include="*.ts" --include="*.tsx" \
  --include="*.mjs" --include="*.md" . | grep -v node_modules
```

---

## Hors périmètre — ne pas « ajouter utilement »

- **MR, issues, pipelines CI** : écartés volontairement. Seuls *commits et lignes
  de code* sont couverts.
- **TanStack Table** : retiré (réécriture v9 à l'API plugin) au profit d'un
  `DataTable` maison + `@tanstack/react-virtual`.
- **Design system d'entreprise** : écarté, thème dashboard autonome.

---

## Structure

```
src/
  gitlab/     client, limiteur AIMD, pagination, endpoints      ← zéro React
  sync/       coordinateur multi-instances, moteur 3 vagues,
              planificateur, agrégation, identités, miroirs     ← zéro React
  store/      IndexedDB (+ migration v1→v2), dataset mémoire,
              fichier .json (File System Access), stores Zustand
  query/      filtres, agrégations, granularité, sélection
  viz/        attribution des couleurs
  components/ primitives, graphiques ECharts, tableau, filtres
  routes/     Onboarding · Sync · Global · Projets · Personnes · Comparer · Réglages
```

Le sync se fait en 3 vagues : découverte (~3 appels) → aperçu contributeurs
(1 appel/dépôt, classement en ~40 s) → historique daté (N appels/dépôt).
Les chiffres de la vague 1 sont **all-time sans filtre de date** : ils servent
d'aperçu, jamais de source pour les graphes temporels.

**Les tokens ne sont jamais écrits** en base ni dans le `.json` exporté :
`sessionStorage`, ou `localStorage` sur choix explicite.
