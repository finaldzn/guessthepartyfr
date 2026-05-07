/* Devine le parti — game logic
 *
 * Two modes:
 *   - server  (window.DLP_CONFIG.STATS_API set): the Worker picks a
 *             candidate via GET /round and validates the guess via
 *             POST /answer. Score, streak and leaderboard are
 *             server-authoritative.
 *   - local   (STATS_API empty): falls back to candidates.json with
 *             client-side scoring. Useful for offline dev.
 */

const PARTIES = [
  "Renaissance",
  "Rassemblement National",
  "La France Insoumise",
  "Les Républicains",
  "Parti Socialiste",
  "Les Écologistes",
];

const PARTY_COLORS = {
  "Renaissance":            "#ECD42E",
  "Rassemblement National": "#1D2D52",
  "La France Insoumise":    "#D81E2D",
  "Les Républicains":       "#0066CC",
  "Parti Socialiste":       "#E92F58",
  "Les Écologistes":        "#00B070",
};

const ADVANCE_DELAY_MS = 2400;
const RECENT_KEEP      = 40;
const STORAGE_KEY      = "dlp.state.v2";
const SESSION_KEY      = "dlp.session.v1";
const NAME_KEY         = "dlp.name.v1";

const STATS_API = (window.DLP_CONFIG && window.DLP_CONFIG.STATS_API) || "";
const SERVER    = !!STATS_API;

const SESSION_ID = (() => {
  let s = localStorage.getItem(SESSION_KEY);
  if (s && s.length >= 16) return s;
  s = (crypto.randomUUID && crypto.randomUUID()) ||
      "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
      });
  try { localStorage.setItem(SESSION_KEY, s); } catch (_) {}
  return s;
})();

const $ = (id) => document.getElementById(id);
const ui = {
  card:      $("card"),
  imgA:      $("img-front"),
  imgB:      $("img-back"),
  cap:       $("caption"),
  who:       $("who"),
  meta:      $("meta"),
  choices:   $("choices"),
  bar:       $("bar"),
  hint:      $("hint"),
  recent:    $("recent"),
  list:      $("recent-list"),
  board:     $("board"),
  boardList: $("board-list"),
  boardMe:   $("board-me"),
  toast:     $("toast"),
  crowd:     $("crowd"),
  crowdBars: $("crowd-bars"),
  crowdCnt:  $("crowd-count"),
  score:     $("m-score"),
  streak:    $("m-streak"),
  best:      $("m-best"),
  rank:      $("m-rank"),
  share:     $("m-share"),
  reset:     $("m-reset"),
  nameBtn:   $("m-name"),
  namedlg:   $("name-dlg"),
  nameInput: $("name-input"),
  nameSave:  $("name-save"),
  nameSkip:  $("name-skip"),
  nameClose: $("name-close"),
};

let pool      = [];     // local-mode only
let byParty   = new Map();
let current   = null;   // server-mode: { round_id, image_url } ; local: full candidate
let answered  = false;
let timer     = null;
let frontEl   = ui.imgA;
let backEl    = ui.imgB;

const state = restore();

// ---- persistence -------------------------------------------------------

function blank() {
  return { score: 0, attempts: 0, streak: 0, best: 0, rank: null, total_players: null, recent: [] };
}

function restore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (raw && typeof raw === "object") return Object.assign(blank(), raw);
  } catch (_) {}
  return blank();
}

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
}

// ---- header ------------------------------------------------------------

function pop(el) {
  if (!el) return;
  el.classList.remove("pop");
  void el.offsetWidth;
  el.classList.add("pop");
}

function paintScore(animate) {
  ui.score.textContent  = `${state.score} / ${state.attempts}`;
  ui.streak.textContent = state.streak;
  ui.best.textContent   = state.best;
  if (ui.rank) {
    if (state.rank && state.total_players) {
      ui.rank.textContent = `#${state.rank}`;
      ui.rank.title       = `${state.rank} sur ${state.total_players} joueur·euses`;
    } else {
      ui.rank.textContent = "—";
      ui.rank.title       = "Classement disponible après 5 réponses.";
    }
  }
  if (animate) {
    pop(ui.score);
    pop(ui.streak);
    if (state.streak > 0 && state.streak === state.best) pop(ui.best);
  }
}

function paintRecent() {
  if (!ui.recent || !ui.list) return;
  if (state.recent.length === 0) {
    ui.recent.hidden = true;
    return;
  }
  ui.recent.hidden = false;
  ui.list.innerHTML = "";
  for (const e of state.recent) {
    const li = document.createElement("li");
    li.className = "entry " + (e.correct ? "ok" : "no");
    li.innerHTML = `
      <img class="thumb" src="" alt="">
      <div class="lines">
        <div class="nm"></div>
        <div class="sub"></div>
      </div>
      <div class="badge"></div>`;
    li.querySelector(".thumb").src = e.image;
    li.querySelector(".nm").textContent = e.name;
    li.querySelector(".sub").textContent = e.correct
      ? `${e.party} · ${e.role}`
      : `${e.party} — vous avez dit ${e.guess}`;
    ui.list.appendChild(li);
  }
}

// ---- toast / share ----------------------------------------------------

function flashToast(msg) {
  if (!ui.toast) return;
  ui.toast.textContent = msg;
  ui.toast.classList.add("show");
  clearTimeout(flashToast._t);
  flashToast._t = setTimeout(() => ui.toast.classList.remove("show"), 2400);
}

async function shareScore() {
  const url = location.origin + location.pathname.replace(/[^/]+$/, "");
  const accuracy = state.attempts ? Math.round(100 * state.score / state.attempts) : 0;
  const lines = [];
  lines.push(`🇫🇷 Devine le parti — ${state.score}/${state.attempts} (${accuracy}%)`);
  lines.push(`Record d'enchaînement : ${state.best}`);
  if (state.rank && state.total_players) {
    const pct = Math.max(1, Math.round(100 * state.rank / state.total_players));
    lines.push(`Classement : #${state.rank} sur ${state.total_players} (top ${pct}%)`);
  }
  lines.push("Saurez-vous faire mieux ?");
  const text = lines.join("\n");

  if (navigator.share) {
    try { await navigator.share({ title: "Devine le parti", text, url }); return; }
    catch (_) {}
  }
  try {
    await navigator.clipboard.writeText(`${text}\n${url}`);
    flashToast("Score copié — partagez-le !");
  } catch (_) {
    flashToast("Copie impossible — partagez l'URL manuellement");
  }
}

// ---- name picker ------------------------------------------------------

function getName()      { return localStorage.getItem(NAME_KEY) || ""; }
function setName(name)  { try { localStorage.setItem(NAME_KEY, name); } catch (_) {} }

function openNameDlg() {
  if (!ui.namedlg) return;
  ui.nameInput.value = getName();
  ui.namedlg.hidden = false;
  setTimeout(() => ui.nameInput.focus(), 30);
}
function closeNameDlg() {
  if (ui.namedlg) ui.namedlg.hidden = true;
}

async function saveName() {
  const v = (ui.nameInput.value || "").trim().slice(0, 24);
  if (v.length < 2) { flashToast("Pseudo trop court"); return; }
  setName(v);
  closeNameDlg();
  if (!SERVER) { flashToast(`Pseudo enregistré : ${v}`); return; }
  try {
    const r = await fetch(`${STATS_API}/name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ session: SESSION_ID, display_name: v }),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    flashToast(`Pseudo enregistré : ${v}`);
  } catch (e) {
    flashToast("Pseudo enregistré localement (le serveur n'a pas pu être joint)");
  }
}

// ---- crowd breakdown --------------------------------------------------

function renderCrowd(data, actual) {
  if (!ui.crowd || !data || !data.total) {
    if (ui.crowd) ui.crowd.hidden = true;
    return;
  }
  const total = data.total;
  ui.crowdCnt.textContent = total === 1 ? "(1 vote)" : `(${total.toLocaleString("fr-FR")} votes)`;

  const ranked = PARTIES
    .map(p => ({ p, n: data.counts[p] || 0 }))
    .sort((a, b) => b.n - a.n);

  ui.crowdBars.innerHTML = "";
  for (const { p, n } of ranked) {
    const pct = Math.round((n / total) * 100);
    const li  = document.createElement("li");
    li.className = "cb" + (p === actual ? " cb-actual" : "");
    li.innerHTML = `
      <span class="cb-name"></span>
      <span class="cb-track"><span class="cb-fill"></span></span>
      <span class="cb-pct"></span>`;
    li.querySelector(".cb-name").textContent = p;
    li.querySelector(".cb-fill").style.width  = pct + "%";
    li.querySelector(".cb-fill").style.background = PARTY_COLORS[p];
    li.querySelector(".cb-pct").textContent  = pct + "%";
    ui.crowdBars.appendChild(li);
  }
  ui.crowd.hidden = false;
}

// ---- leaderboard preview ---------------------------------------------

async function refreshLeaderboard() {
  if (!SERVER || !ui.board || !ui.boardList) return;
  let data;
  try {
    const r = await fetch(`${STATS_API}/leaderboard`);
    if (!r.ok) throw new Error("HTTP " + r.status);
    data = await r.json();
  } catch (_) { return; }

  const top = (data.rows || []).slice(0, 5);
  if (top.length === 0) {
    ui.board.hidden = true;
    return;
  }
  ui.board.hidden = false;
  ui.boardList.innerHTML = "";
  for (const row of top) {
    const li = document.createElement("li");
    li.className = "run";
    const isMe = row.session_id === SESSION_ID || row.display_name === getName();
    if (isMe) li.classList.add("me");
    li.innerHTML = `
      <span class="run-rank"></span>
      <span class="run-name"></span>
      <span class="run-len"></span>
      <span class="run-label">d'affilée</span>`;
    li.querySelector(".run-rank").textContent = "#" + row.rank;
    li.querySelector(".run-name").textContent = row.display_name;
    li.querySelector(".run-len").textContent  = row.best_streak;
    ui.boardList.appendChild(li);
  }
  if (ui.boardMe) {
    if (state.rank && state.total_players) {
      ui.boardMe.hidden = false;
      ui.boardMe.textContent =
        `Vous : #${state.rank} sur ${state.total_players}` +
        (state.best ? ` · record ${state.best}` : "");
    } else {
      ui.boardMe.hidden = true;
    }
  }
}

// ---- candidate pool (local fallback) ---------------------------------

async function loadLocalPool() {
  let data;
  try {
    const r = await fetch("candidates.json", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
  } catch (_) {
    ui.hint.textContent = "Impossible de charger candidates.json.";
    return false;
  }
  pool = data.filter(c => c && c.image_url && PARTIES.includes(c.party));
  if (pool.length === 0) { ui.hint.textContent = "Aucun candidat."; return false; }
  byParty.clear();
  for (const c of pool) {
    if (!byParty.has(c.party)) byParty.set(c.party, []);
    byParty.get(c.party).push(c);
  }
  ui.hint.textContent = `${pool.length} candidats chargés (mode local).`;
  return true;
}

function drawLocal() {
  const partyKeys = [...byParty.keys()];
  const p = partyKeys[Math.floor(Math.random() * partyKeys.length)];
  const list = byParty.get(p);
  return list[Math.floor(Math.random() * list.length)];
}

// ---- card flow --------------------------------------------------------

function swapPortrait(src) {
  backEl.onload = () => {
    backEl.classList.add("shown");
    frontEl.classList.remove("shown");
    [frontEl, backEl] = [backEl, frontEl];
    if (current) current.shownAt = performance.now();
  };
  backEl.onerror = () => { nextRound(); };
  backEl.src = src;
}

async function nextRound() {
  clearTimeout(timer);
  if (ui.crowd) ui.crowd.hidden = true;
  ui.cap.classList.remove("visible");
  ui.bar.classList.remove("run");
  for (const b of ui.choices.children) {
    b.disabled = false;
    b.classList.remove("was-correct", "was-wrong");
  }
  answered = false;

  if (SERVER) {
    try {
      const r = await fetch(`${STATS_API}/round?session=${encodeURIComponent(SESSION_ID)}`);
      if (!r.ok) throw new Error("HTTP " + r.status);
      current = await r.json();        // { round_id, image_url }
    } catch (e) {
      ui.hint.textContent = "Le serveur n'est pas joignable. Réessayez dans un instant.";
      return;
    }
  } else {
    current = drawLocal();
  }
  swapPortrait(current.image_url);
}

async function answer(party) {
  if (answered || !current) return;
  answered = true;

  const dt = current.shownAt ? Math.round(performance.now() - current.shownAt) : null;

  // Lock buttons immediately (before await) for snappy feedback.
  for (const b of ui.choices.children) b.disabled = true;

  let result;
  if (SERVER) {
    try {
      const r = await fetch(`${STATS_API}/answer`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          session:          SESSION_ID,
          round_id:         current.round_id,
          guessed_party:    party,
          time_to_guess_ms: dt,
        }),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      result = await r.json();
    } catch (e) {
      ui.hint.textContent = "Réponse perdue (réseau). Manche suivante…";
      timer = setTimeout(nextRound, 1200);
      return;
    }
  } else {
    const correct = party === current.party;
    result = {
      correct,
      actual_party:  current.party,
      name:          current.name,
      role:          current.role,
      image_url:     current.image_url,
      breakdown:     null,
      session_stats: null,
      rank:          null,
      total_players: null,
    };
  }

  // Visual: mark correct + wrong.
  for (const b of ui.choices.children) {
    if (b.dataset.party === result.actual_party)               b.classList.add("was-correct");
    else if (b.dataset.party === party && !result.correct)     b.classList.add("was-wrong");
  }

  // Reveal caption.
  ui.who.textContent  = result.name;
  ui.meta.textContent = `${result.actual_party} · ${result.role}`;
  ui.cap.classList.add("visible");

  // State update — server-authoritative if available.
  if (result.session_stats) {
    state.score    = result.session_stats.total_correct;
    state.attempts = result.session_stats.total_attempts;
    state.streak   = result.session_stats.current_streak;
    state.best     = result.session_stats.best_streak;
    state.rank          = result.rank          || null;
    state.total_players = result.total_players || null;
  } else {
    // local mode bookkeeping
    state.attempts++;
    if (result.correct) {
      state.score++;
      state.streak++;
      if (state.streak > state.best) state.best = state.streak;
    } else {
      state.streak = 0;
    }
  }

  // Recent guesses list (local UI only).
  state.recent.unshift({
    name:    result.name,
    party:   result.actual_party,
    role:    result.role,
    image:   result.image_url,
    guess:   party,
    correct: result.correct,
  });
  if (state.recent.length > RECENT_KEEP) state.recent.length = RECENT_KEEP;

  paintScore(true);
  paintRecent();
  persist();

  // Crowd breakdown.
  if (result.breakdown) {
    renderCrowd(result.breakdown, result.actual_party);
  } else if (SERVER && current.id) {
    // unlikely path
    fetch(`${STATS_API}/breakdown?id=${current.id}`).then(r => r.json()).then(d => renderCrowd(d, result.actual_party)).catch(() => {});
  }

  // First time the user crosses the leaderboard threshold (5+ attempts),
  // refresh the global preview.
  if (SERVER && state.attempts === 5) refreshLeaderboard();
  // And every 10 attempts after, to keep things fresh without spamming.
  if (SERVER && state.attempts > 5 && state.attempts % 10 === 0) refreshLeaderboard();

  ui.bar.style.setProperty("--ms", ADVANCE_DELAY_MS + "ms");
  void ui.bar.offsetWidth;
  ui.bar.classList.add("run");
  timer = setTimeout(nextRound, ADVANCE_DELAY_MS);
}

// ---- event wiring ----------------------------------------------------

ui.choices.addEventListener("click", (e) => {
  const b = e.target.closest(".party");
  if (b) answer(b.dataset.party);
});

ui.card.addEventListener("click", (e) => {
  if (answered && !e.target.closest(".party")) {
    clearTimeout(timer);
    nextRound();
  }
});

document.addEventListener("keydown", (e) => {
  if (ui.namedlg && !ui.namedlg.hidden) return;
  if (e.key >= "1" && e.key <= "6" && !answered) {
    answer(PARTIES[parseInt(e.key, 10) - 1]);
    return;
  }
  if (answered && (e.key === " " || e.key === "Enter" || e.key === "ArrowRight")) {
    e.preventDefault();
    clearTimeout(timer);
    nextRound();
  }
});

ui.reset.addEventListener("click", () => {
  if (!confirm("Effacer l'historique local ? (Score serveur conservé)")) return;
  state.recent = [];
  persist();
  paintRecent();
});

ui.share.addEventListener("click", shareScore);
if (ui.nameBtn)  ui.nameBtn.addEventListener("click", openNameDlg);
if (ui.nameSave) ui.nameSave.addEventListener("click", saveName);
if (ui.nameSkip) ui.nameSkip.addEventListener("click", closeNameDlg);
if (ui.nameClose) ui.nameClose.addEventListener("click", closeNameDlg);
if (ui.nameInput) ui.nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter")  { e.preventDefault(); saveName(); }
  if (e.key === "Escape") { closeNameDlg(); }
});

// ---- boot ------------------------------------------------------------

async function bootServer() {
  ui.hint.textContent = "Connexion au serveur…";
  // pull existing stats so the header is correct on a return visit
  try {
    const r = await fetch(`${STATS_API}/me?session=${encodeURIComponent(SESSION_ID)}`);
    if (r.ok) {
      const d = await r.json();
      if (d.me) {
        state.score    = d.me.total_correct;
        state.attempts = d.me.total_attempts;
        state.streak   = d.me.current_streak;
        state.best     = d.me.best_streak;
      }
      state.rank          = d.rank          || null;
      state.total_players = d.total_players || null;
      paintScore(false);
    }
  } catch (_) {}
  ui.hint.textContent = "À vous de jouer.";
  refreshLeaderboard();

  // If we have a name locally but the server doesn't know it (e.g. fresh
  // device, or the row was wiped), tell the server.
  if (getName() && SERVER) {
    fetch(`${STATS_API}/name`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ session: SESSION_ID, display_name: getName() }),
    }).catch(() => {});
  } else if (!getName() && SERVER && state.attempts === 0) {
    // First-time visitors: prompt for a name (non-blocking).
    setTimeout(openNameDlg, 1200);
  }
}

(async function () {
  paintScore(false);
  paintRecent();
  if (SERVER) {
    await bootServer();
  } else {
    if (!await loadLocalPool()) return;
  }
  nextRound();
})();
