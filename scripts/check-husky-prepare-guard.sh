#!/usr/bin/env bash

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
  local should_invoke="$3"

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
    echo "FAIL: $label — script crashed (exit $rc) instead of exiting 0 cleanly"
    FAILED=$((FAILED + 1))
  elif [ "$should_invoke" = "yes" ] && [ "$rc" -ne 0 ]; then
    echo "FAIL: $label — script crashed (exit $rc) despite invoking husky"
    FAILED=$((FAILED + 1))
  else
    echo "PASS: $label — husky invocation=$invoked (expected $should_invoke)"
    PASSED=$((PASSED + 1))
  fi
}

SCENARIO_A="$TEST_TMPDIR/standalone"
mkdir -p "$SCENARIO_A/.git" "$SCENARIO_A/.husky"
touch "$SCENARIO_A/.husky/pre-commit" "$SCENARIO_A/.husky/pre-push"
run_scenario "standalone-clone" "$SCENARIO_A" "yes"

SCENARIO_B="$TEST_TMPDIR/standalone-worktree"
mkdir -p "$SCENARIO_B/.husky"
echo "gitdir: /some/real/gitdir" > "$SCENARIO_B/.git"
touch "$SCENARIO_B/.husky/pre-commit" "$SCENARIO_B/.husky/pre-push"
run_scenario "standalone-worktree" "$SCENARIO_B" "yes"

SCENARIO_C_PARENT="$TEST_TMPDIR/monorepo"
SCENARIO_C="$SCENARIO_C_PARENT/public/open-knowledge"
mkdir -p "$SCENARIO_C_PARENT/.git" "$SCENARIO_C/.husky"
touch "$SCENARIO_C/.husky/pre-commit" "$SCENARIO_C/.husky/pre-push"
run_scenario "monorepo-subdirectory" "$SCENARIO_C" "no"

SCENARIO_D="$TEST_TMPDIR/standalone-no-hooks"
mkdir -p "$SCENARIO_D/.git"
run_scenario "standalone-no-hooks" "$SCENARIO_D" "no"

SCENARIO_E="$TEST_TMPDIR/standalone-only-pre-commit"
mkdir -p "$SCENARIO_E/.git" "$SCENARIO_E/.husky"
touch "$SCENARIO_E/.husky/pre-commit"
run_scenario "standalone-only-pre-commit" "$SCENARIO_E" "yes"

SCENARIO_F="$TEST_TMPDIR/standalone-only-pre-push"
mkdir -p "$SCENARIO_F/.git" "$SCENARIO_F/.husky"
touch "$SCENARIO_F/.husky/pre-push"
run_scenario "standalone-only-pre-push" "$SCENARIO_F" "yes"

echo ""
echo "Results: $PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
