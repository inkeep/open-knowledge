#!/usr/bin/env bash
#
# Test: husky prepare guard distinguishes standalone OK clone from
# agents-private monorepo context, and only invokes husky in the former.
#
# Background: OK's `prepare` script invokes `husky` to install git hooks.
# In a standalone clone (inkeep/open-knowledge), `.git` lives at OK root
# and husky writes core.hooksPath there — correct. Inside the
# agents-private monorepo, OK has no own `.git`, so husky walks up,
# finds the parent's `.git`, and writes core.hooksPath there with a path
# pointing back at OK's `.husky/`. That clobbers the parent's intended
# `.husky/` setup and makes `git push` from anywhere in agents-private
# fire OK's hook (`pnpm run format && pnpm run lint && pnpm run check`)
# instead of the parent's intended `pnpm check:monorepo-traps && pnpm check:pre-push`.
#
# The fix: a guard at the start of OK's prepare script that detects
# the monorepo context and skips husky in that case. The discriminator
# is whether `.git` exists relative to OK's cwd (it does in standalone
# clones, it does not in the monorepo).
#
# This test invokes the guard script in two simulated environments and
# asserts husky is invoked exactly when expected.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREPARE_SCRIPT="$SCRIPT_DIR/husky-prepare.sh"

if [ ! -f "$PREPARE_SCRIPT" ]; then
  echo "FAIL: $PREPARE_SCRIPT does not exist"
  echo "      Expected the husky prepare guard at this path."
  exit 1
fi
if [ ! -x "$PREPARE_SCRIPT" ]; then
  echo "FAIL: $PREPARE_SCRIPT is not executable"
  exit 1
fi

TEST_TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TEST_TMPDIR"' EXIT

# Stub `pnpm` so the guard's `pnpm exec husky` call is observable without
# requiring a real husky binary. The stub records each invocation to
# the file pointed to by $TEST_INVOCATION_LOG (set by each scenario).
STUB_DIR="$TEST_TMPDIR/stub-bin"
mkdir -p "$STUB_DIR"
cat > "$STUB_DIR/pnpm" <<'EOF'
#!/usr/bin/env bash
echo "pnpm invoked: $*" >> "$TEST_INVOCATION_LOG"
EOF
chmod +x "$STUB_DIR/pnpm"

PASSED=0
FAILED=0

run_scenario() {
  local label="$1"
  local cwd="$2"
  local should_invoke="$3"  # "yes" or "no"

  local log="$TEST_TMPDIR/$label.log"
  : > "$log"

  local rc=0
  TEST_INVOCATION_LOG="$log" PATH="$STUB_DIR:$PATH" \
    bash -c "cd '$cwd' && bash '$PREPARE_SCRIPT'" 2>&1 || rc=$?

  local invoked="no"
  [ -s "$log" ] && invoked="yes"

  if [ "$invoked" != "$should_invoke" ]; then
    echo "FAIL: $label — husky invocation=$invoked (expected $should_invoke)"
    [ -s "$log" ] && { echo "      stub log:"; sed 's/^/        /' "$log"; }
    FAILED=$((FAILED + 1))
  elif [ "$should_invoke" = "no" ] && [ "$rc" -ne 0 ]; then
    # Skip-husky case: guard must exit 0 cleanly. A non-zero exit means the
    # script crashed before/after the guard check — the empty invocation log
    # would otherwise pass this scenario as a false positive.
    echo "FAIL: $label — script crashed (exit $rc) instead of exiting 0 cleanly"
    FAILED=$((FAILED + 1))
  elif [ "$should_invoke" = "yes" ] && [ "$rc" -ne 0 ]; then
    # Invoke-husky case: pnpm was called but the script still exited non-zero,
    # meaning something after pnpm crashed (e.g., chmod under set -euo pipefail).
    echo "FAIL: $label — script crashed (exit $rc) despite invoking husky"
    FAILED=$((FAILED + 1))
  else
    echo "PASS: $label — husky invocation=$invoked (expected $should_invoke)"
    PASSED=$((PASSED + 1))
  fi
}

# Scenario A: standalone clone — `.git` is at the cwd
SCENARIO_A="$TEST_TMPDIR/standalone"
mkdir -p "$SCENARIO_A/.git" "$SCENARIO_A/.husky"
touch "$SCENARIO_A/.husky/pre-commit" "$SCENARIO_A/.husky/pre-push"
run_scenario "standalone-clone" "$SCENARIO_A" "yes"

# Scenario B: standalone worktree — `.git` is a FILE pointing at the
# real gitdir (created by `git worktree add`). Should still invoke.
SCENARIO_B="$TEST_TMPDIR/standalone-worktree"
mkdir -p "$SCENARIO_B/.husky"
echo "gitdir: /some/real/gitdir" > "$SCENARIO_B/.git"
touch "$SCENARIO_B/.husky/pre-commit" "$SCENARIO_B/.husky/pre-push"
run_scenario "standalone-worktree" "$SCENARIO_B" "yes"

# Scenario C: monorepo — `.git` is in a parent dir, NOT at cwd
SCENARIO_C_PARENT="$TEST_TMPDIR/monorepo"
SCENARIO_C="$SCENARIO_C_PARENT/public/open-knowledge"
mkdir -p "$SCENARIO_C_PARENT/.git" "$SCENARIO_C/.husky"
touch "$SCENARIO_C/.husky/pre-commit" "$SCENARIO_C/.husky/pre-push"
run_scenario "monorepo-subdirectory" "$SCENARIO_C" "no"

# Scenario D: standalone clone WITHOUT husky hooks (public mirror case).
# `.husky/pre-commit` and `pre-push` aren't in the Copybara include list,
# so a fresh public clone has `.git` but no hook files. Guard should skip
# husky setup to avoid creating empty `_/` scaffolding.
SCENARIO_D="$TEST_TMPDIR/standalone-no-hooks"
mkdir -p "$SCENARIO_D/.git"
# Deliberately do NOT create .husky/pre-commit or pre-push.
run_scenario "standalone-no-hooks" "$SCENARIO_D" "no"

# Scenario E: standalone clone with only pre-commit (no pre-push).
# Should still invoke husky — at least one hook exists.
SCENARIO_E="$TEST_TMPDIR/standalone-only-pre-commit"
mkdir -p "$SCENARIO_E/.git" "$SCENARIO_E/.husky"
touch "$SCENARIO_E/.husky/pre-commit"
run_scenario "standalone-only-pre-commit" "$SCENARIO_E" "yes"

# Scenario F: standalone clone with only pre-push (no pre-commit).
# Symmetric to E — exercises the other branch of the `! -f pre-commit
# && ! -f pre-push` conjunction in husky-prepare.sh.
SCENARIO_F="$TEST_TMPDIR/standalone-only-pre-push"
mkdir -p "$SCENARIO_F/.git" "$SCENARIO_F/.husky"
touch "$SCENARIO_F/.husky/pre-push"
run_scenario "standalone-only-pre-push" "$SCENARIO_F" "yes"

echo ""
echo "Results: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
