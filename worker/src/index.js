// dlp-stats — Cloudflare Worker behind D1 that records anonymous guesses
// and exposes a public per-candidate breakdown.
//
//   POST /guess        body: { candidate_id, guessed_party, actual_party, session_id?, time_to_guess_ms? }
//   GET  /breakdown?id=N
//
// CORS is locked to the GitHub Pages origin (and localhost for dev).
// Bind a D1 database called `DB` in wrangler.toml.

const PARTIES = [
  "Renaissance",
  "Rassemblement National",
  "La France Insoumise",
  "Les Républicains",
  "Parti Socialiste",
  "Les Écologistes",
];

const ALLOWED_ORIGINS = new Set([
  "https://finaldzn.github.io",
  "http://localhost:8000",
  "http://localhost:8765",
  "http://127.0.0.1:8000",
  "http://127.0.0.1:8765",
]);

function corsHeaders(req) {
  const origin = req.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : "https://finaldzn.github.io";
  return {
    "Access-Control-Allow-Origin":  allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age":       "86400",
    "Vary":                         "Origin",
  };
}

function json(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type":  "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const ch  = corsHeaders(req);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: ch });
    }

    // ---- POST /guess ------------------------------------------------------
    if (req.method === "POST" && url.pathname === "/guess") {
      let body;
      try { body = await req.json(); }
      catch { return json({ error: "bad json" }, 400, ch); }

      const cid     = Number(body.candidate_id);
      const guessed = String(body.guessed_party || "");
      const actual  = String(body.actual_party  || "");
      const sid     = String(body.session_id || "").slice(0, 64) || null;
      const dt      = Number.isFinite(+body.time_to_guess_ms)
                        ? Math.max(0, Math.min(60000, Math.round(+body.time_to_guess_ms)))
                        : null;

      if (!Number.isInteger(cid) || cid <= 0)
        return json({ error: "candidate_id" }, 400, ch);
      if (!PARTIES.includes(guessed) || !PARTIES.includes(actual))
        return json({ error: "party" }, 400, ch);

      try {
        await env.DB.prepare(
          "INSERT INTO guesses (candidate_id, guessed_party, actual_party, session_id, time_to_guess_ms) VALUES (?,?,?,?,?)"
        ).bind(cid, guessed, actual, sid, dt).run();
      } catch (e) {
        return json({ error: "db", message: String(e) }, 500, ch);
      }

      return json({ ok: true }, 200, ch);
    }

    // ---- GET /breakdown ---------------------------------------------------
    if (req.method === "GET" && url.pathname === "/breakdown") {
      const cid = Number(url.searchParams.get("id"));
      if (!Number.isInteger(cid) || cid <= 0)
        return json({ error: "id" }, 400, ch);

      let rows;
      try {
        const r = await env.DB.prepare(
          "SELECT guessed_party, COUNT(*) AS n FROM guesses WHERE candidate_id = ? GROUP BY guessed_party"
        ).bind(cid).all();
        rows = r.results || [];
      } catch (e) {
        return json({ error: "db", message: String(e) }, 500, ch);
      }

      const counts = {};
      let total = 0;
      for (const row of rows) {
        counts[row.guessed_party] = row.n;
        total += row.n;
      }
      // CDN-cache for 15 s — this dominates cost on a popular candidate.
      return json({ candidate_id: cid, total, counts }, 200, {
        ...ch,
        "Cache-Control": "public, max-age=15",
      });
    }

    // ---- GET /healthz -----------------------------------------------------
    if (req.method === "GET" && url.pathname === "/healthz") {
      return json({ ok: true, ts: new Date().toISOString() }, 200, ch);
    }

    return json({ error: "not found" }, 404, ch);
  },
};
