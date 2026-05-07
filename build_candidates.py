"""
Build candidates.json for the Devine le parti game.

Pulls live rosters from three open-data sources:
  - Assemblée nationale  (députés, légis. 17)
      data.assemblee-nationale.fr  + photos served by assemblee-nationale.fr
  - Sénat                (sénateurs en activité)
      data.senat.fr CSV  + photos served by senat.fr
  - Parlement européen   (eurodéputés français)
      europarl.europa.eu MEP XML list  + mepphoto JPGs

Each candidate is mapped to one of six "game parties":
  Renaissance, Rassemblement National, La France Insoumise,
  Les Républicains, Parti Socialiste, Les Écologistes.

Politicians whose group does not map cleanly (LIOT, GDR, RDSE, NI,
Reconquête, Indépendants, etc.) are skipped — accuracy matters more
than coverage. Photos are HEAD-checked in parallel and dropped on 404.

Usage: python3 build_candidates.py
Stdlib only.
"""

from __future__ import annotations

import csv
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unicodedata
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from concurrent.futures import ThreadPoolExecutor
from glob import glob

UA = "DevineLeParti/1.0 (open-data game; ops@example.org)"

AN_ZIP = (
    "https://data.assemblee-nationale.fr/static/openData/repository/17/amo/"
    "deputes_actifs_mandats_actifs_organes/"
    "AMO10_deputes_actifs_mandats_actifs_organes.json.zip"
)
AN_PHOTO = "https://www.assemblee-nationale.fr/dyn/static/tribun/17/photos/carre/{id}.jpg"

SEN_CSV = "https://data.senat.fr/data/senateurs/ODSEN_GENERAL.csv"
SEN_PHOTO = "https://www.senat.fr/senimg/{slug}_carre.jpg"

MEP_XML = "https://www.europarl.europa.eu/meps/fr/full-list/xml"
MEP_PHOTO = "https://www.europarl.europa.eu/mepphoto/{id}.jpg"

OUTPUT = "candidates.json"


# ---- party mapping ---------------------------------------------------------

# AN groupe parlementaire (sigle) -> game party
AN_GP_TO_PARTY = {
    "EPR":     "Renaissance",
    "Dem":     "Renaissance",
    "HOR":     "Renaissance",
    "RN":      "Rassemblement National",
    "LFI-NFP": "La France Insoumise",
    "DR":      "Les Républicains",
    "UDR":     "Les Républicains",
    "SOC":     "Parti Socialiste",
    "EcoS":    "Les Écologistes",
}

# Sénat "Groupe politique" (libellé exact) -> game party
SEN_GROUP_TO_PARTY = {
    "Les Républicains": "Les Républicains",
    "Union Centriste":  "Renaissance",
    "Socialiste, Écologiste et Républicain":           "Parti Socialiste",
    "Rassemblement des démocrates, progressistes et indépendants": "Renaissance",
    "Écologiste – Solidarité et Territoires":          "Les Écologistes",
    "Rassemblement National":                          "Rassemblement National",
    # Some Sénat exports use slightly different shorthands; normalised below.
    "RDPI": "Renaissance",
    "UC":   "Renaissance",
    "SER":  "Parti Socialiste",
    "GEST": "Les Écologistes",
    "RN":   "Rassemblement National",
    "LR":   "Les Républicains",
}

# MEP "nationalPoliticalGroup" -> game party
MEP_NPG_TO_PARTY = {
    "Rassemblement national":  "Rassemblement National",
    "Renaissance":             "Renaissance",
    "Mouvement Démocrate":     "Renaissance",
    "Horizons":                "Renaissance",
    "La France Insoumise":     "La France Insoumise",
    "Les Républicains":        "Les Républicains",
    "Parti socialiste":        "Parti Socialiste",
    "Place publique":          "Parti Socialiste",
    "Les Écologistes":         "Les Écologistes",
}


# ---- helpers ---------------------------------------------------------------

def http_get(url: str, *, timeout: int = 60) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def head_ok(url: str, *, timeout: int = 12) -> bool:
    """Return True if the URL serves an image with HTTP 200."""
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status == 200 and r.headers.get("content-type", "").startswith("image/")
    except Exception:
        return False


def slugify_sen(nom: str, prenom: str) -> str:
    """Replicate the Sénat photo-slug: lowercased, unaccented, ' ' and '-' → '_'."""
    def fold(s: str) -> str:
        s = unicodedata.normalize("NFKD", s)
        s = "".join(c for c in s if not unicodedata.combining(c))
        s = s.lower()
        s = re.sub(r"[ '\-]+", "_", s)
        s = re.sub(r"[^a-z0-9_]", "", s)
        return s
    return f"{fold(nom)}_{fold(prenom)}"


# ---- AN --------------------------------------------------------------------

def load_an() -> list[dict]:
    print("• AN: downloading active députés zip…")
    blob = http_get(AN_ZIP)
    tmp = tempfile.mkdtemp(prefix="an_")
    try:
        with zipfile.ZipFile(io.BytesIO(blob)) as z:
            z.extractall(tmp)
        organes = {}
        for f in glob(os.path.join(tmp, "json", "organe", "*.json")):
            o = json.load(open(f, encoding="utf-8"))["organe"]
            organes[o["uid"]] = o

        rows = []
        for f in glob(os.path.join(tmp, "json", "acteur", "*.json")):
            a = json.load(open(f, encoding="utf-8"))["acteur"]
            uid = a["uid"]["#text"]            # e.g. "PA721908"
            num = uid[2:] if uid.startswith("PA") else uid
            ec = a["etatCivil"]["ident"]
            full = f"{ec.get('prenom','').strip()} {ec.get('nom','').strip()}".strip()

            # current GP (groupe parlementaire)
            mandats = a.get("mandats", {}).get("mandat")
            if not isinstance(mandats, list):
                mandats = [mandats] if mandats else []
            sigle = None
            for m in mandats:
                if not isinstance(m, dict):
                    continue
                if m.get("typeOrgane") == "GP" and not m.get("dateFin"):
                    o = organes.get((m.get("organes") or {}).get("organeRef"))
                    if o:
                        sigle = o.get("libelleAbrege")
                        break

            party = AN_GP_TO_PARTY.get(sigle)
            if not party:
                continue

            rows.append({
                "name":      full,
                "party":     party,
                "role":      "Député",
                "image_url": AN_PHOTO.format(id=num),
                "_source":   "AN",
            })
        print(f"  → {len(rows)} députés mapped to game parties")
        return rows
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---- Sénat -----------------------------------------------------------------

def load_senat() -> list[dict]:
    print("• Sénat: downloading CSV…")
    blob = http_get(SEN_CSV)
    text = blob.decode("latin-1")
    text = "".join(l for l in text.splitlines(keepends=True) if not l.startswith("%"))
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for row in reader:
        if row.get("État") != "ACTIF":
            continue
        group_label = (row.get("Groupe politique") or "").strip()
        party = SEN_GROUP_TO_PARTY.get(group_label)
        if not party:
            continue
        matricule = row["Matricule"].strip()
        nom = row["Nom usuel"].strip()
        prenom = row["Prénom usuel"].strip()
        slug = slugify_sen(nom, prenom) + matricule.lower()
        rows.append({
            "name":      f"{prenom} {nom}",
            "party":     party,
            "role":      "Sénateur" if row.get("Qualité") == "M." else "Sénatrice",
            "image_url": SEN_PHOTO.format(slug=slug),
            "_source":   "Sénat",
        })
    print(f"  → {len(rows)} sénateurs mapped to game parties")
    return rows


# ---- MEPs ------------------------------------------------------------------

def load_meps() -> list[dict]:
    print("• Parlement européen: downloading MEP XML…")
    xml = http_get(MEP_XML)
    root = ET.fromstring(xml)
    rows = []
    for mep in root.findall("mep"):
        if (mep.findtext("country") or "").strip() != "France":
            continue
        npg = (mep.findtext("nationalPoliticalGroup") or "").strip()
        party = MEP_NPG_TO_PARTY.get(npg)
        if not party:
            continue
        full = (mep.findtext("fullName") or "").strip()
        # The XML capitalises the family name; normalise to "First Last".
        parts = full.split()
        normalised = " ".join(p if p.isupper() is False else p.capitalize() for p in parts)
        # Better: keep accents/case in given names but title-case the SHOUTING surname.
        normalised = re.sub(r"\b([A-ZÀ-Ý]{2,})\b",
                            lambda m: m.group(1).capitalize(),
                            full)
        mid = (mep.findtext("id") or "").strip()
        rows.append({
            "name":      normalised,
            "party":     party,
            "role":      "Députée européenne" if False else "Député européen",  # XML has no sex; default masc.
            "image_url": MEP_PHOTO.format(id=mid),
            "_source":   "PE",
        })
    print(f"  → {len(rows)} eurodéputés français mapped to game parties")
    return rows


# ---- main ------------------------------------------------------------------

def main():
    rows = []
    rows += load_an()
    rows += load_senat()
    rows += load_meps()

    # de-dup by (name, party) — a député may also sit on senat lists historically.
    seen = set()
    deduped = []
    for r in rows:
        key = (r["name"].lower(), r["party"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(r)
    print(f"• after de-dup: {len(deduped)} rows")

    # parallel HEAD verify of every photo URL
    print("• verifying photo URLs in parallel…")
    with ThreadPoolExecutor(max_workers=24) as ex:
        results = list(ex.map(lambda r: head_ok(r["image_url"]), deduped))
    kept = [r for r, ok in zip(deduped, results) if ok]
    dropped = [r for r, ok in zip(deduped, results) if not ok]
    print(f"  → {len(kept)} kept, {len(dropped)} dropped (no photo)")

    # show drop summary so the operator can sanity-check
    if dropped:
        from collections import Counter
        c = Counter((r["_source"], r["party"]) for r in dropped)
        for (src, party), n in c.most_common():
            print(f"     dropped {n:3} {src}/{party}")

    # final shape: drop _source, add an id, sort for stable output
    kept.sort(key=lambda r: (r["party"], r["name"]))
    out = []
    for i, r in enumerate(kept, start=1):
        out.append({
            "id":        i,
            "name":      r["name"],
            "party":     r["party"],
            "role":      r["role"],
            "image_url": r["image_url"],
            "source":    r["_source"],
        })

    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"\n✓ wrote {OUTPUT} with {len(out)} candidates")

    # per-party balance summary
    from collections import Counter
    print("\nParty distribution:")
    for p, n in Counter(r["party"] for r in out).most_common():
        print(f"  {n:4}  {p}")


if __name__ == "__main__":
    sys.exit(main() or 0)
