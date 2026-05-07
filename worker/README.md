# dlp-stats — Cloudflare Worker for crowd guesses

Anonymous endpoint that records every guess and returns the per-candidate
party breakdown. Backed by **Cloudflare D1** (SQLite) — entirely on the
Workers free tier (100 k inserts/day, 5 M row-reads/day).

## Endpoints

| Method | Path                | Body / query                                                      |
| ------ | ------------------- | ----------------------------------------------------------------- |
| `POST` | `/guess`            | `{ candidate_id, guessed_party, actual_party, session_id?, time_to_guess_ms? }` |
| `GET`  | `/breakdown?id=N`   | → `{ candidate_id, total, counts: { "Renaissance": 12, ... } }`   |
| `GET`  | `/healthz`          | → `{ ok: true, ts: ... }`                                         |

CORS is locked to `https://finaldzn.github.io` (and localhost for dev).

## One-time deploy

```sh
cd worker
npm i -g wrangler           # if not installed
wrangler login              # opens a browser
wrangler d1 create dlp      # prints { database_id: "..." }
# Paste that database_id into wrangler.toml under [[d1_databases]]
wrangler d1 execute dlp --remote --file schema.sql
wrangler deploy             # prints https://dlp-stats.<your-subdomain>.workers.dev
```

Then in the repo root, edit `config.js`:

```js
window.DLP_CONFIG = {
  STATS_API: "https://dlp-stats.<your-subdomain>.workers.dev",
};
```

…commit, push to `main`, and the live site at
`https://finaldzn.github.io/guessthepartyfr/` will start showing the
crowd breakdown after every reveal.

## Local dev

```sh
wrangler dev               # http://127.0.0.1:8787
# In another shell:
python3 -m http.server 8000
# Edit config.js → STATS_API: "http://127.0.0.1:8787"
# Open http://localhost:8000
```

## Inspecting the DB

```sh
wrangler d1 execute dlp --remote --command "SELECT COUNT(*) FROM guesses"
wrangler d1 execute dlp --remote --command "SELECT guessed_party, COUNT(*) FROM guesses WHERE candidate_id = 123 GROUP BY guessed_party"
```
