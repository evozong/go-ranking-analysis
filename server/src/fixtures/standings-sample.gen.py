#!/usr/bin/env python3
"""Generate a fully synthetic OpenGotha short-format standings-table CSV.

Deterministic Swiss-ish pairing so every Rx cell is internally consistent
(each game appears in both players' rows with mirrored results). An ODD field
(13 players) so every fully-paired round produces a genuine `0+` bye. Also
covers: comma-in-name rows, a single-round absence (`0-` -> participating bit
0), and one forced draw (`=`). No real tournament data.

Run: python3 standings-sample.gen.py > standings-sample.csv
"""

NAMES = [
    "Anna Bell",
    "Carl Dean",
    "Eve Frost",
    "Gus Hale",
    "Ivy Jung",
    "Kwan Yat Hei, George",
    "Mara Nord",
    "Omar Pace",
    "Rae Quinn",
    "Sam True",
    "Tan Yu Xin, Benjamin",
    "Uma Vale",
    "Will Yorke",
]
ROUNDS = 5
ABSENT = {13: {3}}  # player 13 sits out round 3 only
DRAWS = {(1, 2, 1)}  # (lo_num, hi_num, round) forced jigo

N = len(NAMES)
cells = {n: {} for n in range(1, N + 1)}  # cells[num][rnd] = "<opp><+|-|=>"
score = {n: 0.0 for n in range(1, N + 1)}
had_bye = set()

for rnd in range(1, ROUNDS + 1):
    active = [n for n in range(1, N + 1) if rnd not in ABSENT.get(n, set())]
    order = sorted(active, key=lambda n: (-score[n], n))

    if len(order) % 2 == 1:
        # give the bye to the lowest-standing player who has not had one yet
        bye = next((n for n in reversed(order) if n not in had_bye), order[-1])
        order.remove(bye)
        had_bye.add(bye)
        cells[bye][rnd] = "0+"
        score[bye] += 1

    for i in range(0, len(order), 2):
        a, b = order[i], order[i + 1]
        lo, hi = min(a, b), max(a, b)
        if (lo, hi, rnd) in DRAWS:
            cells[a][rnd] = f"{b}="
            cells[b][rnd] = f"{a}="
            score[a] += 0.5
            score[b] += 0.5
        else:
            w, l = lo, hi  # lower seed wins
            cells[w][rnd] = f"{l}+"
            cells[l][rnd] = f"{w}-"
            score[w] += 1

    for n in range(1, N + 1):
        cells[n].setdefault(rnd, "0-")  # absent / not paired


def q(s):
    return '"' + s.replace('"', '""') + '"'


rcols = [f"R{i}" for i in range(1, ROUNDS + 1)]
header = ["Num", "Pl", "Name", "Female", "Rk", "NbW", *rcols, "NBW", "SOS", "SOSOS"]
lines = [",".join(q(h) for h in header)]
for n in range(1, N + 1):
    wins = sum(1 for r in range(1, ROUNDS + 1) if cells[n][r].endswith("+"))
    row = [
        str(n), str(n), NAMES[n - 1], "false", "30K", str(wins),
        *[cells[n][r] for r in range(1, ROUNDS + 1)],
        str(wins), "0", "0",
    ]
    lines.append(",".join(q(c) for c in row))

print("\n".join(lines))
