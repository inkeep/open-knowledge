#!/usr/bin/env bash
#
# Fail if any GitHub Actions `setup-node` step provisions Node from a literal
# version instead of reading the repo's `.node-version` pin.
#
# Why this exists:
#   `.node-version` is the single source of truth for the toolchain — .npmrc and
#   CONTRIBUTING.md both say so — but nothing enforces it on its own.
#   `engine-strict` only enforces the `engines.node` FLOOR (>=24) and never
#   fires on a Node NEWER than the pin, and a workflow that hardcodes
#   `node-version: "24"` floats across whatever 24.x is latest on the day the
#   job runs. `node-version-file: .node-version` is what makes the file
#   authoritative in CI; this guard is what keeps a literal version from
#   re-opening the drift, by failing `pnpm run check` instead.
#
# Scope: workflows and local composite actions. Both are invoked with the repo
# checked out at $GITHUB_WORKSPACE (composite actions here are all referenced as
# `./.github/composite-actions/...`), so `.node-version` resolves for both.
#
# Deliberate exceptions: none today. If a job genuinely needs a different Node
# (e.g. testing against a future release), add its `<file>:<line>` to ALLOWLIST
# below with a comment saying why — an empty allowlist is the healthy state.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

# Entries are "<path>:<literal node-version value>", e.g.
# ".github/workflows/future-node.yml:node-version: \"26\"".
ALLOWLIST=()

fail() {
  echo "::error::$1" >&2
  shift
  for line in "$@"; do
    echo "$line" >&2
  done
  exit 1
}

# 1. The pin itself must exist and look like a full x.y.z version. A bare "24"
#    here would defeat the point: setup-node would float across 24.x again.
if [[ ! -f .node-version ]]; then
  fail "Missing .node-version" \
    "The toolchain pin is the single source of truth for CI and local Node." \
    "Recreate it with the exact version the project builds on, e.g. 24.18.0."
fi

PIN="$(tr -d '[:space:]' < .node-version)"
if [[ ! "$PIN" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail ".node-version must pin an exact x.y.z version (found: '$PIN')" \
    "A partial version (e.g. '24') lets setup-node float across the minor line," \
    "which is the drift this pin exists to prevent."
fi

# 2. The pin must satisfy the engines.node floor in package.json. These are two
#    independent declarations of the same policy; if they disagree, `pnpm install`
#    fails under engine-strict on a machine that correctly honoured the pin.
FLOOR="$(node -p "require('./package.json').engines.node" 2>/dev/null || echo "")"
if [[ -n "$FLOOR" ]]; then
  if ! node -e '
    const [pin, range] = process.argv.slice(1);
    const m = range.match(/>=\s*(\d+)/);
    if (!m) process.exit(0);
    process.exit(Number(pin.split(".")[0]) >= Number(m[1]) ? 0 : 1);
  ' "$PIN" "$FLOOR"; then
    fail ".node-version ($PIN) is below the engines.node floor ($FLOOR)" \
      "pnpm runs with engine-strict=true, so an install on the pinned Node would fail."
  fi
fi

# 3. No literal node-version anywhere under .github/.
shopt -s nullglob
TARGETS=(.github/workflows/*.yml .github/workflows/*.yaml .github/composite-actions/*/action.yml)

violations=()
while IFS= read -r hit; do
  [[ -z "$hit" ]] && continue
  file="${hit%%:*}"
  rest="${hit#*:}"
  value="$(sed 's/^[0-9]*://' <<<"$rest" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  allowed=0
  for entry in ${ALLOWLIST+"${ALLOWLIST[@]}"}; do
    [[ "$entry" == "$file:$value" ]] && allowed=1 && break
  done
  (( allowed )) || violations+=("$hit")
done < <(grep -rn '^[[:space:]]*node-version:' "${TARGETS[@]}" 2>/dev/null || true)

if (( ${#violations[@]} > 0 )); then
  fail "Hardcoded node-version in ${#violations[@]} step(s) — use the .node-version pin instead" \
    "" \
    "$(printf '  %s\n' "${violations[@]}")" \
    "Replace each with:" \
    "  node-version-file: .node-version" \
    "" \
    "See the header of scripts/check-node-version-pins.sh for why."
fi

# 4. Every setup-node step must actually declare a version source. Without one,
#    setup-node silently uses the runner's preinstalled Node — a third, invisible
#    version. Counting is enough given step 3 already forbids the literal form.
setup_steps="$(grep -rc 'uses:[[:space:]]*actions/setup-node@' "${TARGETS[@]}" 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}')"
pinned_steps="$(grep -rc '^[[:space:]]*node-version-file:[[:space:]]*\.node-version[[:space:]]*$' "${TARGETS[@]}" 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}')"

if [[ "$setup_steps" != "$pinned_steps" ]]; then
  fail "setup-node steps ($setup_steps) and '.node-version' pins ($pinned_steps) disagree" \
    "Every actions/setup-node step needs 'node-version-file: .node-version'." \
    "A step with no version key falls back to the runner's preinstalled Node."
fi

echo "Node version pins OK — $setup_steps setup-node step(s) read .node-version ($PIN)."
