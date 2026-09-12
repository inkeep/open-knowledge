#!/bin/sh
if [ -n "$OK_TEST_SKIP_I18N_COMPILE" ]; then
  echo "[predev] i18n:compile skipped (OK_TEST_SKIP_I18N_COMPILE set)"
  exit 0
fi
exec pnpm run i18n:compile
