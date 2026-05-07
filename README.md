# Devine le parti

Mini-jeu : reconnaître le parti politique d'un·e député·e, sénateur·rice ou
eurodéputé·e français·e à partir de sa photo.

🎮 **En ligne :** <https://finaldzn.github.io/guessthepartyfr/>

Inspiré par [guesstheparty.co.uk](https://guesstheparty.co.uk/), réécrit pour
le paysage politique français à partir de données ouvertes.

## Sources

| Mandat              | Roster                                                                                            | Photos                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Députés (légis. 17) | `data.assemblee-nationale.fr` — `AMO10_deputes_actifs_mandats_actifs_organes`                     | `assemblee-nationale.fr/dyn/static/tribun/17/photos/carre/{id}.jpg` |
| Sénateurs           | `data.senat.fr` — `ODSEN_GENERAL.csv`                                                             | `senat.fr/senimg/{slug}_carre.jpg`                                  |
| Eurodéputés FR      | `europarl.europa.eu/meps/fr/full-list/xml`                                                        | `europarl.europa.eu/mepphoto/{id}.jpg`                              |

Les ministres ne forment pas une liste séparée : la plupart sont déjà
député·es ou sénateur·rices et apparaissent à ce titre. Les collaborateurs
parlementaires ne sont pas inclus — leurs photos ne sont publiées par aucune
des sources officielles.

## Partis du jeu

Six partis (regroupant les groupes parlementaires alliés) :

- **Renaissance** — EPR + Démocrates + Horizons (AN), UC + RDPI (Sénat),
  Renaissance + MoDem + Horizons (PE)
- **Rassemblement National**
- **La France Insoumise**
- **Les Républicains** — DR + UDR (AN)
- **Parti Socialiste** — SOC + Place publique
- **Les Écologistes**

Les élu·es des groupes mixtes (LIOT, GDR, RDSE, NI, Indépendants, Reconquête,
sans-parti) sont écartés : la cartographie partisane ne serait pas fiable.

## Fonctionnalités

- 🎯 Photo + 6 boutons, score / série / record persistés en `localStorage`
- 🏆 Tableau des records locaux (top 10 enchaînements)
- 📤 Bouton « Partager » (Web Share API + repli presse-papier)
- 📊 « Le public a répondu » : pourcentage par parti après chaque réponse,
  agrégé sur tous les visiteurs (Cloudflare Worker + D1)

## Lancer le jeu

```sh
python3 build_candidates.py    # produit candidates.json (~900 candidats)
python3 -m http.server 8000    # puis ouvrir http://localhost:8000
```

## Structure

```
build_candidates.py    # ETL : open-data → candidates.json
candidates.json        # roster final (généré)
config.js              # URL du Worker crowd-stats (vide = désactivé)
index.html             # page de jeu
stats.html             # statistiques (localStorage + tableau des records)
style.css
game.js
worker/                # backend Cloudflare (D1 + Worker, voir worker/README.md)
.github/workflows/     # déploiement auto du Worker
```

## Crowd-stats (back-end)

Le Worker enregistre chaque réponse anonyme et expose
`GET /breakdown?id=N`. Voir [`worker/README.md`](worker/README.md) pour
le déploiement initial.

### Auto-déploiement par GitHub Actions

Tout `push` sur `main` qui touche `worker/**` redéploie le Worker.
Une seule configuration à faire (Settings → Secrets and variables → Actions) :

| Secret                     | Valeur                                            |
| -------------------------- | ------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`     | jeton Cloudflare avec Workers + D1 + Account Read |
| `CLOUDFLARE_ACCOUNT_ID`    | id de votre compte Cloudflare                     |

## Confidentialité

Score, série et historique restent dans le `localStorage` du navigateur.
Si `config.js` configure un Worker, chaque réponse envoie au Worker un
identifiant de session anonyme (UUID local), l'id du candidat, le parti
deviné, le parti réel et le temps de réponse — rien d'autre. Aucune
information personnelle n'est collectée.

## Licence

[MIT](LICENSE).
