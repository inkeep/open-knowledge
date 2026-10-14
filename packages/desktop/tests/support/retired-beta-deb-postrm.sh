#!/bin/bash

case "$1" in
    upgrade | failed-upgrade | abort-upgrade | [1-9]*) exit 0 ;;
esac

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove 'openknowledge-beta' '/usr/bin/openknowledge-beta'
else
    rm -f '/usr/bin/openknowledge-beta'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/openknowledge-beta'

if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  rm -f "$APPARMOR_PROFILE_DEST"
fi

for link in /usr/bin/ok-beta /usr/bin/open-knowledge-beta; do
  if [ -L "$link" ]; then
    target=$(readlink "$link")
    case "$target" in
      '/opt/OpenKnowledge Beta/'*) rm -f "$link" ;;
    esac
  fi
done
