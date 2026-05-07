/* Devine le parti — game logic */

const PARTIES = [
  "Renaissance",
  "Rassemblement National",
  "La France Insoumise",
  "Les Républicains",
  "Parti Socialiste",
  "Les Écologistes",
];

const ADVANCE_DELAY_MS = 1900;
const RECENT_KEEP      = 40;
const STORAGE_KEY      = "dlp.state.v1";

const $ = (id) => document.getElementById(id);
const ui = {
  card:    $("card"),
  imgA:    $("img-front"),
  imgB:    $("img-back"),
  cap:     $("caption"),
  who:     $("who"),
  meta:    $("meta"),
  choices: $("choices"),
  bar:     $("bar"),
  hint:    $("hint"),
  recent:  $("recent"),
  list:    $("recent-list"),
  score:   $("m-score"),
  streak:  $("m-streak"),
  best:    $("m-best"),
  reset:   $("m-reset"),
};

let pool = [];
let byParty = new Map();          // party -> [candidates] for balanced sampling
let current = null;
let answered = false;
let timer = null;
let frontEl = ui.imgA;
let backEl  = ui.imgB;

const state = restore();

// ----- persistence -------------------------------------------------------

function blank() {
  return { score: 0, attempts: 0, streak: 0, best: 0, recent: [], byParty: {} };
}

function restore() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (raw && typeof raw.score === "number") return Object.assign(blank(), raw);
  } catch (_) {}
  return blank();
}

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (_) {}
}

// ----- rendering ---------------------------------------------------------

function pop(el) {
  el.classList.remove("pop");
  void el.offsetWidth;
  el.classList.add("pop");
}

function paintScore(animate) {
  ui.score.textContent  = `${state.score} / ${state.attempts}`;
  ui.streak.textContent = state.streak;
  ui.best.textContent   = state.best;
  if (animate) {
    pop(ui.score);
    pop(ui.streak);
    if (state.streak > 0 && state.streak === state.best) pop(ui.best);
  }
}

function paintRecent() {
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

// ----- candidate pool ---------------------------------------------------

async function loadPool() {
  let data;
  try {
    const r = await fetch("candidates.json", { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
  } catch (e) {
    ui.hint.textContent =
      "Impossible de charger candidates.json. Lancez `python3 -m http.server` " +
      "dans ce dossier puis ouvrez http://localhost:8000";
    return false;
  }

  pool = data.filter((c) => c && c.image_url && PARTIES.includes(c.party));
  if (pool.length === 0) {
    ui.hint.textContent = "Aucun candidat. Lancez d'abord build_candidates.py.";
    return false;
  }

  byParty.clear();
  for (const c of pool) {
    if (!byParty.has(c.party)) byParty.set(c.party, []);
    byParty.get(c.party).push(c);
  }
  ui.hint.textContent = `${pool.length} candidats chargés (députés, sénateurs, eurodéputés).`;
  return true;
}

// Pick the next candidate by first choosing a party uniformly,
// then a candidate uniformly from that party. This balances the
// game even though Renaissance/LR have far more elected officials
// than Les Écologistes.
function drawNext() {
  const partyKeys = [...byParty.keys()];
  const p = partyKeys[Math.floor(Math.random() * partyKeys.length)];
  const list = byParty.get(p);
  return list[Math.floor(Math.random() * list.length)];
}

// ----- round flow -------------------------------------------------------

function swapPortrait(src) {
  backEl.onload = () => {
    backEl.classList.add("shown");
    frontEl.classList.remove("shown");
    [frontEl, backEl] = [backEl, frontEl];
  };
  backEl.onerror = () => {
    // Skip silently if a photo URL has gone stale.
    nextRound();
  };
  backEl.src = src;
}

function nextRound() {
  clearTimeout(timer);
  current  = drawNext();
  answered = false;

  ui.cap.classList.remove("visible");
  ui.bar.classList.remove("run");
  for (const b of ui.choices.children) {
    b.disabled = false;
    b.classList.remove("was-correct", "was-wrong");
  }
  swapPortrait(current.image_url);
}

function answer(party) {
  if (answered || !current) return;
  answered = true;

  const correct = party === current.party;
  state.attempts += 1;
  if (correct) {
    state.score  += 1;
    state.streak += 1;
    if (state.streak > state.best) state.best = state.streak;
  } else {
    state.streak = 0;
  }

  // per-party tally for the stats page
  const tally = state.byParty[current.party] || { seen: 0, ok: 0 };
  tally.seen += 1;
  if (correct) tally.ok += 1;
  state.byParty[current.party] = tally;

  for (const b of ui.choices.children) {
    b.disabled = true;
    if (b.dataset.party === current.party)        b.classList.add("was-correct");
    else if (b.dataset.party === party && !correct) b.classList.add("was-wrong");
  }

  ui.who.textContent  = current.name;
  ui.meta.textContent = `${current.party} · ${current.role}`;
  ui.cap.classList.add("visible");

  state.recent.unshift({
    name:    current.name,
    party:   current.party,
    role:    current.role,
    image:   current.image_url,
    guess:   party,
    correct,
  });
  if (state.recent.length > RECENT_KEEP) state.recent.length = RECENT_KEEP;

  paintScore(true);
  paintRecent();
  persist();

  ui.bar.style.setProperty("--ms", ADVANCE_DELAY_MS + "ms");
  void ui.bar.offsetWidth;
  ui.bar.classList.add("run");
  timer = setTimeout(nextRound, ADVANCE_DELAY_MS);
}

// ----- input handling --------------------------------------------------

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
  if (!confirm("Tout remettre à zéro (score, série et historique) ?")) return;
  Object.assign(state, blank());
  persist();
  paintScore(false);
  paintRecent();
});

// ----- boot -----------------------------------------------------------

(async function () {
  paintScore(false);
  paintRecent();
  if (await loadPool()) nextRound();
})();
