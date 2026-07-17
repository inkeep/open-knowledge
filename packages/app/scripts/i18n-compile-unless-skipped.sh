#!/bin/sh
# predev i18n gate: e2e fixture-spawned dev servers set
# OK_TEST_SKIP_I18N_COMPILE=1 because N concurrent boots otherwise run
# `lingui compile` + `biome format --write` against the SHARED
# src/locales/*/messages.json — racing writers tear the JSON for any
# concurrent reader (the corrupted-catalog playwright failure in CI run
# 27182560489, reproduced locally by check:full:parallel booting the
# e2e/visual/a11y projects together). The catalogs are committed and
# drift-checked in CI, and the e2e warm-cache globalSetup boot (single,
# uncontended, before any worker) compiles them once per run.
if [ -n "$OK_TEST_SKIP_I18N_COMPILE" ]; then
  echo "[predev] i18n:compile skipped (OK_TEST_SKIP_I18N_COMPILE set)"
  exit 0
fi
exec pnpm run i18n:compile
