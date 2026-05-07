# Devine le parti

Mini-jeu : reconnaître le parti politique d'un·e député·e, sénateur·rice ou
eurodéputé·e français·e à partir de sa photo.

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

## Lancer le jeu

```sh
python3 build_candidates.py    # produit candidates.json (~900 candidats)
python3 -m http.server 8000    # puis ouvrir http://localhost:8000
```

## Structure

```
build_candidates.py    # ETL : open-data → candidates.json
candidates.json        # roster final (généré)
index.html             # page de jeu
stats.html             # statistiques locales (localStorage)
style.css
game.js
```

## Confidentialité

Aucune donnée n'est envoyée à un serveur tiers. Score et historique restent
dans le `localStorage` du navigateur. Les photos sont chargées directement
depuis les sites officiels (AN, Sénat, Parlement européen).
