// dlp-stats — Cloudflare Worker behind D1 for Devine le parti
//
// Server-authoritative scoring. The answer is never sent to the client
// before they answer: a /round picks a random candidate, returns an
// opaque round_id + photo_url; /answer resolves the round, validates
// the guess against the candidates table, and updates the session.
//
//   GET  /round?session=SID                      → { round_id, image_url }
//   POST /answer { session, round_id, guessed }  → { correct, actual_party, name, role, breakdown, session_stats, rank }
//   POST /name   { session, display_name }       → { ok }
//   GET  /leaderboard                            → top 20 sessions
//   GET  /me?session=SID                         → my row + my rank
//   GET  /breakdown?id=N                         → public per-candidate breakdown
//   GET  /healthz                                → liveness
//
// CORS is locked to https://finaldzn.github.io (and localhost for dev).

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

const ROUND_TTL_MS = 60_000;          // a round expires after 60 s
const MIN_REPLY_MS = 200;             // fastest plausible human reaction
const NAME_MIN     = 2;
const NAME_MAX     = 24;
const LB_LIMIT     = 20;

// ---------------------------------------------------------------------------

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

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function looksLikeSession(s) {
  return typeof s === "string" && /^[0-9a-fA-F-]{16,64}$/.test(s);
}

function cleanName(raw) {
  let n = String(raw || "").replace(/\s+/g, " ").trim();
  if (n.length < NAME_MIN) return null;
  if (n.length > NAME_MAX) n = n.slice(0, NAME_MAX);
  // Strip control chars and zero-width spaces; keep accents.
  n = n.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, "");
  if (n.length < NAME_MIN) return null;
  return n;
}

async function touchSession(env, sid, displayName = null) {
  // INSERT-OR-IGNORE then update last_seen.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO sessions (session_id, display_name) VALUES (?, ?)"
  ).bind(sid, displayName).run();
  if (displayName) {
    await env.DB.prepare(
      "UPDATE sessions SET display_name = ?, last_seen = datetime('now') WHERE session_id = ?"
    ).bind(displayName, sid).run();
  } else {
    await env.DB.prepare(
      "UPDATE sessions SET last_seen = datetime('now') WHERE session_id = ?"
    ).bind(sid).run();
  }
}

async function rankOf(env, sid) {
  const r = await env.DB.prepare(
    "SELECT 1 + COUNT(*) AS rank FROM sessions WHERE best_streak > " +
    "(SELECT best_streak FROM sessions WHERE session_id = ?)"
  ).bind(sid).first();
  return r ? r.rank : null;
}

async function totalSessions(env) {
  const r = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sessions WHERE total_attempts > 0"
  ).first();
  return r ? r.n : 0;
}

// ---------------------------------------------------------------------------

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const ch  = corsHeaders(req);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: ch });
    }

    try {
      // ---- GET /healthz -------------------------------------------------
      if (req.method === "GET" && url.pathname === "/healthz") {
        return json({ ok: true, ts: new Date().toISOString() }, 200, ch);
      }

      // ---- GET /round?session=SID --------------------------------------
      if (req.method === "GET" && url.pathname === "/round") {
        const sid = url.searchParams.get("session");
        if (!looksLikeSession(sid)) return json({ error: "session" }, 400, ch);

        const row = await env.DB.prepare(
          "SELECT id, image_url FROM candidates ORDER BY RANDOM() LIMIT 1"
        ).first();
        if (!row) return json({ error: "no candidates" }, 503, ch);

        const round_id = uuid();
        await env.DB.prepare(
          "INSERT INTO rounds (round_id, session_id, candidate_id) VALUES (?,?,?)"
        ).bind(round_id, sid, row.id).run();
        await touchSession(env, sid);

        return json({ round_id, image_url: row.image_url }, 200, ch);
      }

      // ---- POST /answer ------------------------------------------------
      if (req.method === "POST" && url.pathname === "/answer") {
        let body;
        try { body = await req.json(); }
        catch { return json({ error: "bad json" }, 400, ch); }

        const sid       = body.session;
        const round_id  = String(body.round_id || "");
        const guessed   = String(body.guessed_party || "");
        const dt        = Number.isFinite(+body.time_to_guess_ms)
                            ? Math.max(0, Math.min(60000, Math.round(+body.time_to_guess_ms)))
                            : null;

        if (!looksLikeSession(sid))            return json({ error: "session" }, 400, ch);
        if (!/^[0-9a-fA-F-]{32,40}$/.test(round_id))
                                                return json({ error: "round_id" }, 400, ch);
        if (!PARTIES.includes(guessed))         return json({ error: "party" }, 400, ch);

        // Resolve round and protect against replay/foreign-session use.
        const r = await env.DB.prepare(
          "SELECT round_id, session_id, candidate_id, issued_at, answered_at " +
          "FROM rounds WHERE round_id = ?"
        ).bind(round_id).first();
        if (!r)                                 return json({ error: "round_unknown" }, 404, ch);
        if (r.session_id !== sid)               return json({ error: "round_mismatch" }, 403, ch);
        if (r.answered_at)                      return json({ error: "round_answered" }, 409, ch);

        const issued = Date.parse(r.issued_at + "Z");
        if (Number.isFinite(issued) && (Date.now() - issued) > ROUND_TTL_MS)
                                                return json({ error: "round_expired" }, 410, ch);

        // Soft floor on time-to-guess: bots can flatten this, but we record
        // it for moderation later instead of rejecting the answer.
        const tooFast = dt != null && dt < MIN_REPLY_MS;

        const c = await env.DB.prepare(
          "SELECT id, name, party, role, image_url FROM candidates WHERE id = ?"
        ).bind(r.candidate_id).first();
        if (!c)                                 return json({ error: "candidate_gone" }, 500, ch);

        const correct = guessed === c.party;

        // 1) mark round answered
        await env.DB.prepare(
          "UPDATE rounds SET answered_at = datetime('now'), guessed_party = ?, is_correct = ? WHERE round_id = ?"
        ).bind(guessed, correct ? 1 : 0, round_id).run();

        // 2) record the guess for the public breakdown
        await env.DB.prepare(
          "INSERT INTO guesses (candidate_id, guessed_party, actual_party, session_id, time_to_guess_ms) VALUES (?,?,?,?,?)"
        ).bind(c.id, guessed, c.party, sid, dt).run();

        // 3) update session counters atomically (D1 doesn't have a single
        //    UPDATE-with-CASE that touches best_streak from current_streak,
        //    so we read-modify-write).
        await touchSession(env, sid);
        const sess = await env.DB.prepare(
          "SELECT current_streak, best_streak FROM sessions WHERE session_id = ?"
        ).bind(sid).first();

        const next_streak = correct ? (sess.current_streak + 1) : 0;
        const next_best   = Math.max(sess.best_streak, next_streak);
        await env.DB.prepare(
          "UPDATE sessions SET current_streak = ?, best_streak = ?, " +
          "total_correct = total_correct + ?, total_attempts = total_attempts + 1, " +
          "last_seen = datetime('now') WHERE session_id = ?"
        ).bind(next_streak, next_best, correct ? 1 : 0, sid).run();

        // 4) breakdown for the card we just answered
        const br = await env.DB.prepare(
          "SELECT guessed_party, COUNT(*) AS n FROM guesses WHERE candidate_id = ? GROUP BY guessed_party"
        ).bind(c.id).all();
        const counts = {};
        let total = 0;
        for (const row of br.results || []) { counts[row.guessed_party] = row.n; total += row.n; }

        // 5) latest session_stats and rank
        const fresh = await env.DB.prepare(
          "SELECT current_streak, best_streak, total_correct, total_attempts FROM sessions WHERE session_id = ?"
        ).bind(sid).first();
        const rank  = await rankOf(env, sid);
        const total_players = await totalSessions(env);

        return json({
          correct,
          actual_party:  c.party,
          name:          c.name,
          role:          c.role,
          image_url:     c.image_url,
          breakdown:     { candidate_id: c.id, total, counts },
          session_stats: fresh,
          rank,
          total_players,
          flagged_fast:  tooFast,
        }, 200, ch);
      }

      // ---- POST /name --------------------------------------------------
      if (req.method === "POST" && url.pathname === "/name") {
        let body;
        try { body = await req.json(); }
        catch { return json({ error: "bad json" }, 400, ch); }
        const sid  = body.session;
        const name = cleanName(body.display_name);
        if (!looksLikeSession(sid)) return json({ error: "session" }, 400, ch);
        if (!name)                  return json({ error: "name" }, 400, ch);
        await touchSession(env, sid, name);
        return json({ ok: true, display_name: name }, 200, ch);
      }

      // ---- GET /leaderboard --------------------------------------------
      if (req.method === "GET" && url.pathname === "/leaderboard") {
        const r = await env.DB.prepare(
          "SELECT session_id, display_name, best_streak, total_correct, total_attempts " +
          "FROM sessions WHERE total_attempts >= 5 " +
          "ORDER BY best_streak DESC, total_correct DESC, last_seen DESC LIMIT ?"
        ).bind(LB_LIMIT).all();
        const rows = (r.results || []).map((row, i) => ({
          rank:           i + 1,
          display_name:   row.display_name || "Joueur·euse anonyme",
          best_streak:    row.best_streak,
          total_correct:  row.total_correct,
          total_attempts: row.total_attempts,
          accuracy:       row.total_attempts ? Math.round(100 * row.total_correct / row.total_attempts) : 0,
        }));
        return json({ rows, total_players: await totalSessions(env) }, 200, {
          ...ch,
          "Cache-Control": "public, max-age=20",
        });
      }

      // ---- GET /me?session=SID -----------------------------------------
      if (req.method === "GET" && url.pathname === "/me") {
        const sid = url.searchParams.get("session");
        if (!looksLikeSession(sid)) return json({ error: "session" }, 400, ch);
        const me = await env.DB.prepare(
          "SELECT session_id, display_name, current_streak, best_streak, total_correct, total_attempts " +
          "FROM sessions WHERE session_id = ?"
        ).bind(sid).first();
        if (!me) return json({ rank: null, total_players: await totalSessions(env), me: null }, 200, ch);
        const rank = await rankOf(env, sid);
        return json({
          rank,
          total_players: await totalSessions(env),
          me: {
            display_name:   me.display_name,
            current_streak: me.current_streak,
            best_streak:    me.best_streak,
            total_correct:  me.total_correct,
            total_attempts: me.total_attempts,
            accuracy:       me.total_attempts ? Math.round(100 * me.total_correct / me.total_attempts) : 0,
          },
        }, 200, ch);
      }

      // ---- GET /breakdown?id=N -----------------------------------------
      if (req.method === "GET" && url.pathname === "/breakdown") {
        const cid = Number(url.searchParams.get("id"));
        if (!Number.isInteger(cid) || cid <= 0) return json({ error: "id" }, 400, ch);
        const r = await env.DB.prepare(
          "SELECT guessed_party, COUNT(*) AS n FROM guesses WHERE candidate_id = ? GROUP BY guessed_party"
        ).bind(cid).all();
        const counts = {};
        let total = 0;
        for (const row of r.results || []) { counts[row.guessed_party] = row.n; total += row.n; }
        return json({ candidate_id: cid, total, counts }, 200, {
          ...ch,
          "Cache-Control": "public, max-age=15",
        });
      }

      return json({ error: "not found" }, 404, ch);
    } catch (e) {
      return json({ error: "server", message: String(e && e.message || e) }, 500, ch);
    }
  },
};
