#!/usr/bin/env python3
"""Build the avatar character catalog (run: python3 scripts/build-avatar-characters.py shows|refetch|verify|build)

Usage: shows N, refetch N, verify N (repeat until 0), then build.
Requires Pillow.

Build the avatar character catalog from TVMaze (character art + group art).

Every image is downloaded and checked: HTTP 200, image/* content type,
decodable, portrait height >= 300 px and width >= 240 px for characters,
>= 1280x720 for groups. Results cache in ./chars_cache.json so the script can
run in chunks. Output: src/platform/ios/profiles/characters.json
"""
import io, json, os, re, sys, time, concurrent.futures as cf
import urllib.request, urllib.parse
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "temp", "chars_cache.json")  # temp/ is gitignored
OUT = os.path.join(ROOT, "src", "platform", "ios", "profiles", "characters.json")
UA = {"User-Agent": "SuperPlayer-avatar-builder/1.0"}

CHANNELS = [
    ("Toonami", ["Dragon Ball Z", "Dragon Ball", "Naruto", "Bleach", "One Piece", "Sailor Moon",
                 "Yu Yu Hakusho", "InuYasha", "Mobile Suit Gundam Wing", "Hunter x Hunter",
                 "Fullmetal Alchemist: Brotherhood", "Tenchi Muyo!", "Outlaw Star", "Zatch Bell!"]),
    ("Nickelodeon", ["SpongeBob SquarePants", "The Fairly OddParents", "Danny Phantom",
                     "Avatar: The Last Airbender", "Rugrats", "Hey Arnold!",
                     "The Adventures of Jimmy Neutron: Boy Genius", "The Legend of Korra", "Invader Zim",
                     "CatDog", "The Wild Thornberrys", "Rocko's Modern Life", "As Told by Ginger",
                     "All Grown Up!", "El Tigre: The Adventures of Manny Rivera", "The Loud House",
                     "Teenage Mutant Ninja Turtles 2012", "The Angry Beavers", "Aaahh!!! Real Monsters",
                     "Back at the Barnyard", "My Life as a Teenage Robot", "ChalkZone"]),
    ("Nick Jr.", ["Dora the Explorer", "Blue's Clues", "Go, Diego, Go!", "The Backyardigans",
                  "Wonder Pets!", "PAW Patrol", "Bubble Guppies", "Team Umizoomi", "Little Bill"]),
    ("Cartoon Network", ["Dexter's Laboratory", "The Powerpuff Girls", "Courage the Cowardly Dog",
                         "Ed, Edd n Eddy", "Johnny Bravo", "Samurai Jack", "Codename: Kids Next Door",
                         "The Grim Adventures of Billy & Mandy", "Foster's Home for Imaginary Friends",
                         "Teen Titans", "Ben 10", "Adventure Time", "Regular Show",
                         "The Amazing World of Gumball", "Steven Universe", "Chowder", "Camp Lazlo",
                         "Cow and Chicken", "Megas XLR", "Over the Garden Wall", "We Bare Bears"]),
    ("Boomerang", ["Scooby-Doo, Where Are You!", "The Tom and Jerry Show", "The Flintstones", "The Jetsons",
                   "The Looney Tunes Show", "The Yogi Bear Show", "Wacky Races", "Top Cat",
                   "The Huckleberry Hound Show", "Jonny Quest", "Space Ghost"]),
    ("Disney Channel", ["Kim Possible", "Phineas and Ferb", "Lilo & Stitch: The Series", "The Proud Family",
                        "American Dragon: Jake Long", "Gravity Falls", "Recess", "Fillmore!",
                        "Star vs. the Forces of Evil", "Amphibia", "The Owl House", "DuckTales 2017",
                        "Brandy & Mr. Whiskers", "The Replacements", "Dave the Barbarian", "Pepper Ann"]),
    ("Disney XD", ["Wander Over Yonder", "Kick Buttowski: Suburban Daredevil", "Motorcity", "Tron: Uprising",
                   "Randy Cunningham: 9th Grade Ninja", "Penn Zero: Part-Time Hero", "Milo Murphy's Law"]),
    ("Disney Animation", ["Big Hero 6 The Series", "Tangled: The Series", "The Little Mermaid 1992",
                          "Aladdin 1994", "Hercules 1998", "The Emperor's New School", "Timon & Pumbaa",
                          "Darkwing Duck", "TaleSpin", "Gargoyles", "Chip 'n Dale Rescue Rangers",
                          "Goof Troop", "House of Mouse", "The Lion Guard", "Sofia the First"]),
    ("Pixar", ["Monsters at Work", "Buzz Lightyear of Star Command", "Cars on the Road", "Dug Days",
               "Forky Asks a Question", "Win or Lose"]),
    ("DreamWorks", ["Kung Fu Panda: Legends of Awesomeness", "The Penguins of Madagascar",
                    "Dragons: Riders of Berk", "Trollhunters: Tales of Arcadia", "Voltron: Legendary Defender",
                    "She-Ra and the Princesses of Power", "The Boss Baby: Back in Business",
                    "All Hail King Julien", "Turbo FAST", "Trolls: The Beat Goes On!", "Kung Fu Panda: The Paws of Destiny",
                    "Spirit Riding Free", "The Adventures of Puss in Boots"]),
    ("PBS Kids", ["Arthur", "Clifford the Big Red Dog", "Curious George", "Cyberchase", "Wild Kratts",
                  "Martha Speaks", "WordGirl", "Dinosaur Train", "Peg + Cat", "Daniel Tiger's Neighborhood",
                  "Caillou", "Dragon Tales", "Liberty's Kids", "Odd Squad", "Super Why!"]),
]
MAX_CHARS = 8
SKIP_CHAR = re.compile(r"^(narrator|announcer|various|additional voices|self|host|himself|herself)\b", re.I)


def load_cache():
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    try:
        return json.load(open(CACHE))
    except Exception:
        return {"shows": {}, "imgs": {}}


def get_json(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=15) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(2 + i * 2)
                continue
            if e.code == 404:
                return None
            raise
        except Exception:
            time.sleep(1)
    return None


def check_img(url):
    """(ok, w, h, reason)"""
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=15) as r:
            if r.status != 200:
                return [False, 0, 0, f"status {r.status}"]
            ct = r.headers.get("Content-Type", "")
            if not ct.startswith("image/"):
                return [False, 0, 0, f"type {ct}"]
            data = r.read()
        im = Image.open(io.BytesIO(data))
        im.verify()
        w, h = Image.open(io.BytesIO(data)).size
        return [True, w, h, "ok"]
    except Exception as e:
        return [False, 0, 0, str(e)[:60]]


BAD_NETS = {"Adult Swim"}


def pick_animated(q):
    """Search and take the best animated match (never live action or Adult Swim)."""
    res = get_json("https://api.tvmaze.com/search/shows?" + urllib.parse.urlencode({"q": re.sub(r"\s(19|20)\d\d$", "", q)})) or []
    year = re.search(r"(19|20)\d\d$", q)
    for r in res:
        sh = r["show"]
        net = (sh.get("network") or sh.get("webChannel") or {}).get("name")
        if sh.get("type") != "Animation" or net in BAD_NETS:
            continue
        if year and not (sh.get("premiered") or "").startswith(year.group(0)):
            continue
        return sh["id"]
    return None


def fetch_one(q):
    sid = pick_animated(q)
    time.sleep(0.4)
    if not sid:
        return None
    show = get_json(f"https://api.tvmaze.com/shows/{sid}?embed[]=cast&embed[]=images")
    time.sleep(0.4)
    if not show:
        return None
    return {
        "id": show["id"], "name": show["name"], "type": show.get("type"),
        "net": (show.get("network") or show.get("webChannel") or {}).get("name"),
        "premiered": show.get("premiered"),
        "cast": [{"name": c["character"]["name"], "img": (c["character"].get("image") or {}).get("original")}
                 for c in show.get("_embedded", {}).get("cast", [])],
        "bgs": [i["resolutions"]["original"] for i in show.get("_embedded", {}).get("images", [])
                if i.get("type") == "background"],
    }


def refetch(cache, budget):
    n = 0
    for _, shows in CHANNELS:
        for q in shows:
            s = cache["shows"].get(q)
            if (s and s.get("type") == "Animation") or n >= budget or (s is None and q in cache.get("tried", [])):
                continue
            cache["shows"][q] = fetch_one(q)
            cache.setdefault("tried", []).append(q)
            n += 1
            json.dump(cache, open(CACHE, "w"))
    return n


def fetch_shows(cache, budget):
    n = 0
    for _, shows in CHANNELS:
        for q in shows:
            if q in cache["shows"] or n >= budget:
                continue
            show = get_json("https://api.tvmaze.com/singlesearch/shows?" + urllib.parse.urlencode({"q": q, "embed[]": ["cast", "images"]}, doseq=True))
            cache["shows"][q] = show and {
                "id": show["id"], "name": show["name"],
                "net": (show.get("network") or show.get("webChannel") or {}).get("name"),
                "premiered": show.get("premiered"),
                "cast": [{"name": c["character"]["name"], "img": (c["character"].get("image") or {}).get("original")}
                         for c in show.get("_embedded", {}).get("cast", [])],
                "bgs": [i["resolutions"]["original"] for i in show.get("_embedded", {}).get("images", [])
                        if i.get("type") == "background"],
            }
            n += 1
            json.dump(cache, open(CACHE, "w"))
            time.sleep(0.45)
    return n


def verify(cache, budget):
    urls = []
    for s in cache["shows"].values():
        if not s:
            continue
        urls += [c["img"] for c in s["cast"] if c["img"]]
        urls += [b["url"] for b in s["bgs"][:3]]
    todo = [u for u in dict.fromkeys(urls) if u not in cache["imgs"]][:budget]
    with cf.ThreadPoolExecutor(16) as ex:
        for u, res in zip(todo, ex.map(check_img, todo)):
            cache["imgs"][u] = res
    return len(todo)


def build(cache):
    seen_img, out = set(), []
    for channel, shows in CHANNELS:
        group = {"channel": channel, "shows": []}
        for q in shows:
            s = cache["shows"].get(q)
            if not s:
                continue
            names, chars = set(), []
            for c in s["cast"]:
                u, nm = c["img"], (c["name"] or "").strip()
                if not u or not nm or SKIP_CHAR.search(nm) or u in seen_img:
                    continue
                key = re.sub(r"\W+", "", nm.lower())
                if key in names:
                    continue
                ok, w, h, _ = cache["imgs"].get(u, [False, 0, 0, ""])
                # Clean portrait: sharp enough and portrait-ish framing.
                if not ok or h < 300 or w < 240 or not (0.45 <= w / h <= 1.05):
                    continue
                names.add(key)
                seen_img.add(u)
                chars.append({"name": nm, "img": u, "w": w, "h": h})
                if len(chars) >= MAX_CHARS:
                    break
            grp = None
            for b in s["bgs"][:3]:
                ok, w, h, _ = cache["imgs"].get(b["url"], [False, 0, 0, ""])
                if ok and w >= 1280 and h >= 720 and b["url"] not in seen_img:
                    grp = {"img": b["url"], "w": w, "h": h}
                    seen_img.add(b["url"])
                    break
            if len(chars) >= 3 or grp:
                group["shows"].append({"show": s["name"], "tvmaze": s["id"], "characters": chars if len(chars) >= 3 else [], "group": grp})
        if group["shows"]:
            out.append(group)
    slim = [{"channel": g["channel"], "shows": [{"show": s["show"], "tvmaze": s["tvmaze"],
              "characters": [{"name": c["name"], "img": c["img"]} for c in s["characters"]],
              "group": s["group"]["img"] if s["group"] else None} for s in g["shows"]]} for g in out]
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    json.dump({"source": "TVMaze (api.tvmaze.com), verified at build time", "channels": slim}, open(OUT, "w"), separators=(",", ":"), ensure_ascii=False)
    return out


if __name__ == "__main__":
    cache = load_cache()
    step = sys.argv[1]
    if step == "shows":
        print("fetched", fetch_shows(cache, int(sys.argv[2])))
    elif step == "refetch":
        print("refetched", refetch(cache, int(sys.argv[2])))
    elif step == "verify":
        print("verified", verify(cache, int(sys.argv[2])))
    json.dump(cache, open(CACHE, "w"))
    if step == "build":
        out = build(cache)
        for g in out:
            print(g["channel"], len(g["shows"]), sum(len(s["characters"]) for s in g["shows"]), sum(1 for s in g["shows"] if s["group"]))
    if step == "report":
        for q, s in cache["shows"].items():
            print(q, "=>", s and (s["name"], s["net"], s["premiered"], len(s["cast"])))
