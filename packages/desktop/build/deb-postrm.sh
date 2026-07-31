#!/bin/bash

# after-remove script, shared by the deb AND rpm targets (see the `rpm:` block
# in electron-builder.yml for why one script serves both). The body below the
# guard is a verbatim copy of app-builder-lib's
# templates/linux/after-remove.tpl (a custom afterRemove REPLACES the
# default) + removal of the OpenKnowledge /usr/bin CLI symlinks that
# deb-postinst.sh created. Macro templating applies — bash variables must
# use the brace-less $NAME form (see deb-postinst.sh).

# Upgrade guard — the one place the two packagers genuinely disagree, and the
# reason this is not a verbatim copy. On rpm, the NEW package's %post runs
# BEFORE the old package's %postun, so an unguarded teardown deletes the
# symlinks and the update-alternatives entry that the upgrade just installed,
# leaving `ok` off PATH until the next reinstall. dpkg orders it the other way
# round, so the deb only ever benefited from the guard cosmetically (no window
# where /usr/bin/ok is missing) — but it must not regress, hence one guard
# that reads both dialects:
#   rpm %postun: $1 is the count of instances left after the operation —
#                0 on a real erase, >=1 on an upgrade.
#   deb postrm : $1 is the action word — "remove"/"purge" on a real removal,
#                "upgrade"/"failed-upgrade"/"abort-upgrade" mid-upgrade.
case "$1" in
    upgrade | failed-upgrade | abort-upgrade | [1-9]*) exit 0 ;;
esac

# Delete the link to the binary
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/usr/bin/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

# Remove apparmor profile.
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  rm -f "$APPARMOR_PROFILE_DEST"
fi

# --- OpenKnowledge additions below (keep the copied template above in sync) ---

# Remove the CLI symlinks only if they still point into this install —
# a user-repointed /usr/bin/ok (e.g. npm-global install) is left alone.
for link in /usr/bin/ok /usr/bin/open-knowledge; do
  if [ -L "$link" ]; then
    target=$(readlink "$link")
    case "$target" in
      '/opt/${sanitizedProductName}/'*) rm -f "$link" ;;
    esac
  fi
done
