#!/bin/bash

# deb after-remove script. Verbatim copy of app-builder-lib's
# templates/linux/after-remove.tpl (a custom afterRemove REPLACES the
# default) + removal of the OpenKnowledge /usr/bin CLI symlinks that
# deb-postinst.sh created. Macro templating applies — bash variables must
# use the brace-less $NAME form (see deb-postinst.sh).

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
