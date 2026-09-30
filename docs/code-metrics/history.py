# Commit-history metrics with one set of definitions for tumwater and for the OSS baselines.
#
# Usage: python3 history.py tumwater <checkout> <blame.json> <out.json>
#        python3 history.py oss <clones-dir> <oss-repos.tsv> <out.json>
#
# Non-merge commits only. Lines changed = added + deleted, lockfiles excluded. "Prod commits with
# tests" = commits touching production code that also touch test code. tumwater: its whole
# history up to the checkout's HEAD, split by the commit classes blame.py assigns. OSS: the two
# years before each pinned commit, bot authors excluded, prod/test paths as categories-oss.cjs
# (the EXCLUDE / TEST patterns below are kept identical to it).
import collections as C
import datetime as D
import json
import re
import statistics as st
import subprocess
import sys

LOCK = re.compile(r"(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$")
BOT = re.compile(r"bot|dependabot|renovate|greenkeeper|github-actions|snyk|semantic-release", re.I)
EXCLUDE = re.compile(r"(^|/)(examples?|samples?|benchmarks?|website|docs?|scripts|resources|tools|dist|dist-raw|build|node_modules|typings|client-dist|\.github|\.circleci)(/|$)")
TEST = re.compile(r"(^|/)(test|tests|__tests__|__testUtils__|spec|integration|integrationTests|fixtures)(/|$)|\.(test|spec)\.[cm]?[jt]sx?$")
CODE = re.compile(r"\.([cm]?[jt]s|tsx|jsx)$")
TZ = D.timezone(D.timedelta(hours=-7))  # PDT, where tumwater runs


def read_log(root, since=None):
    args = ["git", "-C", root, "log", "--no-merges", "--numstat", "--format=@@%H%x09%an%x09%ae%x09%at%x09%s"]
    if since:
        args.append(f"--since={since}")
    out = subprocess.run(args, capture_output=True, text=True, errors="replace", check=True).stdout
    commits, cur = [], None
    for line in out.split("\n"):
        if line.startswith("@@"):
            h, an, ae, at, s = line[2:].split("\t", 4)
            cur = dict(h=h, an=an, ae=ae, t=int(at), s=s, files=[])
            commits.append(cur)
        elif line.strip() and cur:
            a, d, f = line.split("\t", 2)
            if "=>" in f:  # rename: keep the destination path
                f = re.sub(r"\{[^}]*=> ([^}]*)\}", r"\1", f).replace("//", "/")
                if " => " in f:
                    f = f.split(" => ")[1]
            cur["files"].append((0 if a == "-" else int(a), 0 if d == "-" else int(d), f))
    return commits


def shape(commits, kind):
    ch = [sum(a + d for a, d, f in c["files"] if not LOCK.search(f)) for c in commits]
    nf = [sum(1 for _, _, f in c["files"] if not LOCK.search(f)) for c in commits]
    prod = [c for c in commits if any(kind(f) == "prod" for _, _, f in c["files"])]
    both = [c for c in prod if any(kind(f) == "test" for _, _, f in c["files"])]
    days = {D.datetime.fromtimestamp(c["t"], TZ).date() for c in commits}
    return {
        "commits": len(commits), "authors": len({c["ae"].lower() for c in commits}), "activeDays": len(days),
        "commitsPerActiveDay": len(commits) / max(1, len(days)),
        "medLines": st.median(ch), "meanLines": st.mean(ch), "p90Lines": sorted(ch)[int(0.9 * len(ch))],
        "medFiles": st.median(nf), "prodCommitsWithTests": len(both) / max(1, len(prod)),
        "medSubject": st.median(len(c["s"]) for c in commits),
        "revertShare": sum(1 for c in commits if re.match(r"revert", c["s"], re.I)) / len(commits),
    }


def tumwater(root, blame_path, out):
    classes = json.load(open(blame_path))["commits"]
    who = lambda c: (lambda k: "tumwater" if k == "tumwater" else "claude" if k.startswith("claude") else "human")(classes.get(c["h"], "human"))
    area = lambda f: "src" if f.startswith("src/") else "test" if f.startswith("test/") else "scripts" if f.startswith("scripts/") \
        else "docs" if f.endswith(".md") or f.startswith(("plans/", "docs/")) else "other"
    kind = lambda f: "prod" if f.startswith("src/") else "test" if f.startswith("test/") else None
    commits = read_log(root)
    res = {"all": shape(commits, kind)}
    for g in ("tumwater", "claude", "human"):
        cs = [c for c in commits if who(c) == g]
        if cs:
            res[g] = shape(cs, kind)
            res[g]["docsOnly"] = sum(1 for c in cs if c["files"] and all(area(f) == "docs" for _, _, f in c["files"])) / len(cs)
            res[g]["byHour"] = [sum(1 for c in cs if D.datetime.fromtimestamp(c["t"], TZ).hour == h) for h in range(24)]
    added = C.Counter()
    for c in commits:
        for a, d, f in c["files"]:
            added[(area(f), "add")] += a
            added[(area(f), "del")] += d
            added[(area(f), who(c))] += a
    res["linesByArea"] = {k: {"added": added[(k, "add")], "deleted": added[(k, "del")],
                              "addedBy": {g: added[(k, g)] for g in ("tumwater", "claude", "human")}}
                          for k in ("src", "test", "docs", "scripts", "other")}
    t0, t1 = min(c["t"] for c in commits), max(c["t"] for c in commits)
    res["spanDays"] = (t1 - t0) / 86400
    res["first"], res["last"] = [D.datetime.fromtimestamp(t, TZ).strftime("%Y-%m-%d %H:%M") for t in (t0, t1)]
    per_day = C.Counter(D.datetime.fromtimestamp(c["t"], TZ).date() for c in commits)
    res["commitsPerDay"] = {"median": st.median(per_day.values()), "max": max(per_day.values())}
    churn = C.Counter()
    for c in commits:
        for a, d, f in c["files"]:
            if f.startswith("src/"):
                churn[f] += a + d
    res["mostChurnedSrc"] = churn.most_common(8)
    json.dump(res, open(out, "w"), indent=1)
    return res


def oss(clones, tsv, out):
    res = {}
    for line in open(tsv):
        if not line.strip() or line.startswith("#"):
            continue
        name, _url, _tag, sha, prod_root = line.rstrip("\n").split("\t")
        root = f"{clones}/{name}"
        t = int(subprocess.run(["git", "-C", root, "log", "-1", "--format=%at", sha], capture_output=True, text=True, check=True).stdout)
        since = D.datetime.fromtimestamp(t - 2 * 365 * 86400).strftime("%Y-%m-%d")

        def kind(f, prod_root=prod_root):
            if EXCLUDE.search(f) or f.endswith(".d.ts") or not CODE.search(f):
                return None
            if TEST.search(f):
                return "test"
            return "prod" if f.startswith(prod_root) and re.search(r"\.([cm]?ts|tsx)$", f) else None
        commits = [c for c in read_log(root, since) if not BOT.search(c["an"] + " " + c["ae"])]
        res[name] = shape(commits, kind)
        res[name]["window"] = f"{since} → {D.datetime.fromtimestamp(t).strftime('%Y-%m-%d')}"
    json.dump(res, open(out, "w"), indent=1)
    return res


def show(res, cols):
    keys = ["commits", "authors", "activeDays", "commitsPerActiveDay", "medLines", "meanLines", "p90Lines", "medFiles",
            "prodCommitsWithTests", "medSubject", "revertShare"]
    fmt = lambda k, v: f"{100 * v:.0f}%" if k in ("prodCommitsWithTests", "revertShare") else f"{v:.1f}" if isinstance(v, float) and v < 100 else f"{v:.0f}"
    print("metric".ljust(22) + "".join(c[:10].rjust(11) for c in cols))
    for k in keys:
        print(k.ljust(22) + "".join(fmt(k, res[c][k]).rjust(11) for c in cols))


if __name__ == "__main__":
    mode = sys.argv[1]
    if mode == "tumwater":
        r = tumwater(*sys.argv[2:5])
        show(r, [c for c in ("all", "tumwater", "claude", "human") if c in r])
        print(f"span {r['spanDays']:.1f} days ({r['first']} → {r['last']} PDT); commits/day median {r['commitsPerDay']['median']} max {r['commitsPerDay']['max']}")
        for k, v in r["linesByArea"].items():
            print(f"  {k:8} +{v['added']:>7} -{v['deleted']:>7}  added by tumwater {v['addedBy']['tumwater']:>6}, claude {v['addedBy']['claude']:>6}")
        for g in ("tumwater", "claude"):
            print(f"  {g} docs-only commits {100 * r[g]['docsOnly']:.0f}%; by hour (PDT): {r[g]['byHour']}")
        print("  most-churned src:", " ".join(f"{f}({n})" for f, n in r["mostChurnedSrc"]))
    else:
        r = oss(*sys.argv[2:5])
        show(r, list(r))
        med = {k: st.median(r[n][k] for n in r) for k in next(iter(r.values())) if k != "window"}
        print("OSS median:", {k: round(v, 3) for k, v in med.items()})
