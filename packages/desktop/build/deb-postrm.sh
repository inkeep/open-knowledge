#!/bin/bash

# UPSTREAM(electron-builder@26.16.1): rpm runs the new package's %post BEFORE the
#   old package's %postun, so an unguarded teardown deletes the symlinks the
#   upgrade just installed. $1 is an rpm instance count or a dpkg action word.
case "$1" in
    upgrade | failed-upgrade | abort-upgrade | [1-9]*) exit 0 ;;
esac

if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/usr/bin/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

rm -f '/etc/apparmor.d/${executable}-userns' '/etc/apparmor.d/${executable}'

for link in /usr/bin/ok /usr/bin/open-knowledge; do
  if [ -L "$link" ]; then
    target=$(readlink "$link")
    case "$target" in
      '/opt/${sanitizedProductName}/'*) rm -f "$link" ;;
    esac
  fi
done
