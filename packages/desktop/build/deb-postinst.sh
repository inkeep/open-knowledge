#!/bin/bash

# deb after-install script. electron-builder's FpmTarget passes custom
# scripts through the SAME macro templating as its defaults — every
# dollar-brace sequence is treated as a macro (unknown names throw at
# build time, comments included), so bash variables here MUST use the
# brace-less $NAME form.
#
# The first half is a verbatim copy of app-builder-lib's
# templates/linux/after-install.tpl (a custom afterInstall REPLACES the
# default, it does not extend it): binary symlink via update-alternatives,
# chrome-sandbox SUID fallback, mime/desktop database refresh, AppArmor
# profile install (Ubuntu 24.04+ userns restriction). The OpenKnowledge
# additions — /usr/bin/ok + /usr/bin/open-knowledge symlinks to the bundled
# CLI wrapper (D10) — are at the bottom. Re-sync the copied half when
# bumping electron-builder.

if type update-alternatives >/dev/null 2>&1; then
    # Remove previous link if it doesn't use update-alternatives
    if [ -L '/usr/bin/${executable}' -a -e '/usr/bin/${executable}' -a "`readlink '/usr/bin/${executable}'`" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' '/opt/${sanitizedProductName}/${executable}' 100 || ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
else
    ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'
fi

# Check if user namespaces are supported by the kernel and working with a quick test:
if ! { [[ -L /proc/self/ns/user ]] && unshare --user true; }; then
    # Use SUID chrome-sandbox only on systems without user namespaces:
    chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
else
    chmod 0755 '/opt/${sanitizedProductName}/chrome-sandbox' || true
fi

if hash update-mime-database 2>/dev/null; then
    update-mime-database /usr/share/mime || true
fi

if hash update-desktop-database 2>/dev/null; then
    update-desktop-database /usr/share/applications || true
fi

# Install apparmor profile. (Ubuntu 24+)
# First check if the version of AppArmor running on the device supports our profile.
# This is in order to keep backwards compatibility with Ubuntu 22.04 which does not support abi/4.0.
# In that case, we just skip installing the profile since the app runs fine without it on 22.04.
if apparmor_status --enabled > /dev/null 2>&1; then
  APPARMOR_PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
  APPARMOR_PROFILE_TARGET='/etc/apparmor.d/${executable}'
  if apparmor_parser --skip-kernel-load --debug "$APPARMOR_PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$APPARMOR_PROFILE_SOURCE" "$APPARMOR_PROFILE_TARGET"
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --replace --write-cache --skip-read-cache "$APPARMOR_PROFILE_TARGET"
    fi
  else
    echo "Skipping the installation of the AppArmor profile as this version of AppArmor does not seem to support the bundled profile"
  fi
fi

# --- OpenKnowledge additions below (keep the copied template above in sync) ---

# CLI-on-PATH (D10): expose the bundled `ok` CLI system-wide. The wrapper
# re-execs the app's Electron binary as a Node host (ELECTRON_RUN_AS_NODE=1),
# so this is a symlink, not a copy — it tracks upgrades in place. Both bin
# names ship, matching the npm package's `ok` + `open-knowledge` bins.
OK_WRAPPER='/opt/${sanitizedProductName}/resources/cli/bin/ok.sh'
if [ -f "$OK_WRAPPER" ]; then
    chmod 0755 "$OK_WRAPPER" || true
    ln -sf "$OK_WRAPPER" /usr/bin/ok
    ln -sf "$OK_WRAPPER" /usr/bin/open-knowledge
fi
