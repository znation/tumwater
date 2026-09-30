#!/bin/sh
# Rebuild every number in docs/code-metrics.md.
#
# Usage: docs/code-metrics/run.sh <tumwater-checkout> <data-dir> [--coverage]
#
#   <tumwater-checkout>  a checkout at the report's "as of" commit whose node_modules resolve (a
#                        worktree inside the primary checkout does), for example
#                          git worktree add --detach .claude/worktrees/metrics-48213ce7 48213ce7
#   <data-dir>           where every intermediate file and output lands; created if missing
#   --coverage           also run the unit suite under NODE_V8_COVERAGE (about a minute; the suite
#                        refuses to run in a checkout a live fleet runs from). Without it, an
#                        existing <data-dir>/v8cov is reused, and without that the coverage split
#                        is skipped.
#   OSS_CLONES=<dir>     where the baselines in oss-repos.tsv are cloned and pinned; default
#                        <data-dir>/oss-src (about 630 MB, most of it nest's history)
#
# Nothing from the baseline repos is installed or executed: they are only parsed and git-logged.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
co=$(cd "$1" && pwd)
mkdir -p "$2"
data=$(cd "$2" && pwd)
clones=${OSS_CLONES:-$data/oss-src}

echo "tumwater checkout $co at $(git -C "$co" rev-parse HEAD)"
node "$here/analyze.cjs" "$co" "$data/metrics.json" "$here/categories-tumwater.cjs"
node "$here/summary.cjs" "$data/metrics.json" > "$data/summary.txt"
python3 "$here/blame.py" "$co" "$data/blame.json" > "$data/blame.txt"
python3 "$here/history.py" tumwater "$co" "$data/blame.json" "$data/history-tumwater.json" > "$data/history-tumwater.txt"
(cd "$co" && npx --no-install eslint --no-config-lookup -c "$here/eslint-complexity.config.mjs" --format json 'src/**/*.ts') > "$data/eslint-cc.json"
node "$here/eslint-cc.cjs" "$data/eslint-cc.json" > "$data/eslint-cc.txt"

if [ "${3:-}" = "--coverage" ]; then
  rm -rf "$data/v8cov"
  (cd "$co" && NODE_V8_COVERAGE="$data/v8cov" npm run test:coverage) > "$data/coverage-run.txt" 2>&1
fi
if [ -d "$data/v8cov" ]; then
  rm -rf "$data/mapdist"
  (cd "$co" && npx --no-install tsc -p tsconfig.json --sourceMap --outDir "$data/mapdist")
  node "$here/coverage.cjs" "$co" "$data/v8cov" "$data/mapdist" "$data/coverage-ts.json" > "$data/coverage.txt"
fi
for scope in all core ui; do SRC_SCOPE=$scope node "$here/authors.cjs" "$data" > "$data/authors-$scope.txt"; done

mkdir -p "$clones" "$data/oss"
grep -v '^#' "$here/oss-repos.tsv" | while IFS="$(printf '\t')" read -r name url tag sha root; do
  [ -d "$clones/$name/.git" ] || git clone -q --no-checkout "$url" "$clones/$name"
  git -C "$clones/$name" checkout -q "$sha"
  echo "$name $tag at $(git -C "$clones/$name" rev-parse HEAD)"
  REPO=$name node --max-old-space-size=8192 "$here/analyze.cjs" "$clones/$name" "$data/oss/$name.json" "$here/categories-oss.cjs"
done
python3 "$here/history.py" oss "$clones" "$here/oss-repos.tsv" "$data/history-oss.json" > "$data/history-oss.txt"
node --max-old-space-size=12288 "$here/compare.cjs" "$data" > "$data/compare.txt"
echo "outputs in $data"
