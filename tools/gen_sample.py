#!/usr/bin/env python3
"""Generate a synthetic Porchfest-style dataset for the Weft prototype.

Everything is fabricated: people, bands, streets and emails are invented, and emails
use the reserved example.com domain. Seeded, so every run produces identical files.

Usage: python3 -I tools/gen_sample.py [outdir]   (default: data/sample)
"""
import csv, os, random, sys
from datetime import datetime, timedelta

SEED = 2027
EVENT_DAY = datetime(2027, 4, 17)          # a Saturday
SLOT_STARTS = [12, 13, 14, 15, 16, 17]     # hourly, 45-minute sets
SET_MINUTES = 45

rnd = random.Random(SEED)
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "data", "sample")
os.makedirs(out, exist_ok=True)

FIRST = ["Avery","Blake","Casey","Dana","Elliot","Frankie","Gray","Harper","Indy","Jordan",
         "Kai","Logan","Morgan","Noel","Oakley","Parker","Quinn","Reese","Sage","Tatum",
         "Uri","Val","Wren","Xen","Yael","Zion","Rowan","Emery","Hollis","Marlow"]
LAST = ["Abernathy","Bellweather","Castellan","Dunmore","Everhart","Fairbanks","Galloway",
        "Hawthorne","Ingram","Juniper","Kingsley","Lockwood","Merriweather","Northcott",
        "Oakhurst","Pemberton","Quillfeather","Ravensworth","Stillwater","Thistledown"]
# Invented street names, kept whimsical so they read as fake.
STREETS = ["Marmalade Way","Tuba Court","Kazoo Lane","Fiddlehead Drive","Banjo Bend",
           "Glockenspiel Ave","Cadenza Circle","Mandolin Row","Ukulele Terrace","Ocarina Loop"]
NEIGHBORHOODS = ["North Grove", "Old Mill", "Riverbend"]
ADJ = ["Velvet","Rusty","Midnight","Paper","Electric","Golden","Hollow","Lucky","Wandering",
       "Crooked","Silver","Backyard","Tin","Sunday","Porchlight"]
NOUN = ["Owls","Lanterns","Hounds","Radio","Kites","Pines","Mockingbirds","Telegraph",
        "Satellites","Peaches","Engines","Sparrows","Orchard","Typewriters","Comets"]
GENRES = ["folk","bluegrass","indie rock","jazz","blues","mariachi","punk","soul",
          "country","funk","a cappella","brass band","singer-songwriter","reggae","classical"]

def person():
    return f"{rnd.choice(FIRST)} {rnd.choice(LAST)}"

def email(name, n):
    return f"{name.lower().replace(' ', '.')}{n}@example.com"

def write(name, rows):
    path = os.path.join(out, f"{name}.csv")
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)
    print(f"{name:12} {len(rows):4} rows -> {os.path.relpath(path)}")

# Spaces are the permission boundary: a user sees a row only if they are a member of its space.
spaces = [
    {"space_id": "festival",   "name": "Festival (public schedule)", "description": "Porches, performers and the published schedule"},
    {"space_id": "volunteers", "name": "Volunteers",                 "description": "Shifts and volunteer contact details"},
    {"space_id": "organizers", "name": "Organizers",                 "description": "Host contacts, private notes, budget"},
]

users = [
    {"user_id": "u-alex",  "display_name": "Alex (test admin)",   "email": "alex.admin@example.com"},
    {"user_id": "u-org",   "display_name": "Olive Organizer",     "email": "olive.organizer@example.com"},
    {"user_id": "u-vol",   "display_name": "Vic Volunteer",       "email": "vic.volunteer@example.com"},
    {"user_id": "u-pub",   "display_name": "Pat Public",          "email": "pat.public@example.com"},
]
# The restricted-user tests rely on these memberships: u-pub sees festival only,
# u-vol never sees organizers rows, u-org and u-alex see everything.
members = [
    {"space_id": s, "user_id": u, "role": r}
    for u, spaces_roles in {
        "u-alex": [("festival","owner"),("volunteers","owner"),("organizers","owner")],
        "u-org":  [("festival","editor"),("volunteers","editor"),("organizers","editor")],
        "u-vol":  [("festival","viewer"),("volunteers","editor")],
        "u-pub":  [("festival","viewer")],
    }.items() for s, r in spaces_roles
]

porches = []
used_addr = set()
for i in range(1, 21):
    while True:
        addr = f"{rnd.randrange(100, 1999, 3)} {rnd.choice(STREETS)}"
        if addr not in used_addr:
            used_addr.add(addr); break
    porches.append({
        "porch_id": f"P{i:02}", "space_id": "festival", "address": addr,
        "neighborhood": NEIGHBORHOODS[(i - 1) % 3],
        "capacity": rnd.choice([40, 60, 80, 100, 150]),
        "accessible": rnd.choice(["yes", "yes", "no"]),
        "power_available": rnd.choice(["yes", "no"]),
        "rain_plan": rnd.choice(["garage", "cancel", "move to P01", "tent"]),
    })

# Host contact details are deliberately in a separate, restricted space.
hosts = []
for p in porches:
    name = person()
    hosts.append({
        "host_id": f"H{p['porch_id'][1:]}", "space_id": "organizers", "porch_id": p["porch_id"],
        "host_name": name, "email": email(name, p["porch_id"][1:]),
        "phone": f"555-01{rnd.randrange(0, 100):02}",   # 555-0100..0199 is reserved for fiction
        "private_notes": rnd.choice(["", "Dog in backyard, keep gate shut", "Neighbor sensitive to noise after 5",
                                     "Prefers acoustic acts", "Has a spare PA", "First-time host"]),
    })

performers, used_names = [], set()
for i in range(1, 46):
    while True:
        band = f"The {rnd.choice(ADJ)} {rnd.choice(NOUN)}"
        if band not in used_names:
            used_names.add(band); break
    contact = person()
    performers.append({
        "performer_id": f"B{i:02}", "space_id": "festival", "name": band,
        "genre": rnd.choice(GENRES), "members": rnd.randint(1, 9),
        "needs_power": rnd.choice(["yes", "no"]), "contact_name": contact,
        "contact_email": email(contact, i),
    })

# Schedule: each performer plays once; no porch double-booked in a slot.
cells = [(p["porch_id"], h) for p in porches for h in SLOT_STARTS]
rnd.shuffle(cells)
slots = []
for n, (perf, (porch_id, hour)) in enumerate(zip(performers, cells), 1):
    start = EVENT_DAY + timedelta(hours=hour)
    slots.append({
        "slot_id": f"S{n:03}", "space_id": "festival", "porch_id": porch_id,
        "performer_id": perf["performer_id"],
        "starts_at": start.isoformat(timespec="minutes"),
        "ends_at": (start + timedelta(minutes=SET_MINUTES)).isoformat(timespec="minutes"),
        "status": rnd.choices(["confirmed", "tentative", "cancelled"], [80, 15, 5])[0],
    })
slots.sort(key=lambda s: (s["starts_at"], s["porch_id"]))

volunteers = []
for i in range(1, 26):
    name = person()
    shift = rnd.choice([(11, 14), (14, 17), (17, 19)])
    volunteers.append({
        "volunteer_id": f"V{i:02}", "space_id": "volunteers", "name": name,
        "email": email(name, 100 + i),
        "role": rnd.choice(["porch captain", "info booth", "setup", "cleanup", "photographer"]),
        "assigned_porch_id": rnd.choice(porches)["porch_id"],
        "shift_start": (EVENT_DAY + timedelta(hours=shift[0])).isoformat(timespec="minutes"),
        "shift_end": (EVENT_DAY + timedelta(hours=shift[1])).isoformat(timespec="minutes"),
    })

for name, rows in [("spaces", spaces), ("users", users), ("members", members), ("porches", porches),
                   ("hosts", hosts), ("performers", performers), ("slots", slots), ("volunteers", volunteers)]:
    write(name, rows)
