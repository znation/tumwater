# Per-line authorship for every tracked text file of a tumwater checkout, at its HEAD.
#
# Usage: python3 blame.py <checkout> <out.json>
#
# `git blame -w -M -C`: whitespace-only edits keep the earlier author, and lines moved or copied
# between files within one commit keep their original author (without -M -C, every file split
# by the organize/dry loops would read as new code by the splitter). Each commit gets a class:
#   tumwater        authored by `tumwater` / `automaton` (the harness's COMMIT_IDENT), or authored
#                   under the repo's own identity with a tumwater(role)/automaton(role) title and
#                   no Claude trailer — a loop agent that ran `git commit` itself (cadb5a35)
#   claude:<model>  any other commit whose Co-Authored-By trailer names Claude (a Claude Code
#                   session; 66 of them also use tumwater(role) titles, so the title alone misleads)
#   human           everything else (5 hand edits to tumwater.json, none surviving)
import concurrent.futures as cf
import collections
import json
import re
import subprocess
import sys

ROOT, OUT = sys.argv[1], sys.argv[2]
git = lambda *a: subprocess.run(["git", "-C", ROOT, *a], capture_output=True, text=True, check=True).stdout

commits = {}
log = git("log", "--format=%H%x1f%an%x1f%(trailers:key=Co-Authored-By,valueonly,separator=%x1e)%x1f%s%x1d")
for rec in log.split("\x1d"):
    rec = rec.strip("\n")
    if not rec:
        continue
    h, an, trailers, subject = rec.split("\x1f")
    if an in ("tumwater", "automaton"):
        c = "tumwater"
    else:
        m = re.search(r"Claude ([A-Za-z]+ [\d.]+)", trailers)
        c = f"claude:{m.group(1)}" if m else ("tumwater" if re.match(r"(tumwater|automaton)(\(|:)", subject) else "human")
    commits[h] = c

files = [f for f in git("ls-files").split("\n") if f and not f.endswith(".png") and f != "package-lock.json"]


def blame(f):
    out = subprocess.run(["git", "-C", ROOT, "blame", "--line-porcelain", "-w", "-M", "-C", "HEAD", "--", f],
                         capture_output=True, text=True, errors="replace").stdout
    shas, times, header = [], [], True
    for line in out.split("\n"):
        if line.startswith("\t"):
            header = True
        elif header and re.match(r"^[0-9a-f]{40} ", line):
            shas.append(line[:40])
            header = False
        elif line.startswith("author-time "):
            times.append(int(line.split()[1]))
    return f, {"cls": [commits.get(s, "human") for s in shas], "sha": shas, "t": times}


with cf.ThreadPoolExecutor(6) as ex:
    result = dict(ex.map(blame, files))
json.dump({"commits": commits, "files": result}, open(OUT, "w"))
print("commit classes:", dict(collections.Counter(commits.values())))
print("blamed lines:", dict(collections.Counter(c for v in result.values() for c in v["cls"])))
