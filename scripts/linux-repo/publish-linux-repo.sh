#!/usr/bin/env bash
# publish-linux-repo.sh — generate a signed apt + rpm repository tree from a
# directory of built packages, ready to sync to the packages bucket.
#
# STATELESS BY DESIGN: the emitted metadata lists ONLY the packages present in
# PACKAGES_DIR (one publish = the current version of one channel). The caller
# syncs the output over the bucket's per-channel prefixes with --delete, so
# the hosted repo is always "latest per channel" — no repo database, no state
# to migrate, nothing to corrupt. Older versions remain downloadable from the
# GitHub Release they shipped on; the repo's job is install + upgrade, not
# archival.
#
# Layout emitted under OUT_DIR (mirrors the bucket layout):
#   apt/openknowledge.gpg                     binary keyring (signed-by=)
#   apt/key.asc                               same key, ASCII-armored
#   apt/dists/<channel>/InRelease             clearsigned Release
#   apt/dists/<channel>/Release, Release.gpg  detached-signature pair
#   apt/dists/<channel>/main/binary-{amd64,arm64}/Packages{,.gz}
#   apt/pool/<channel>/*.deb
#   rpm/key.asc
#   rpm/<channel>/{x86_64,aarch64}/*.rpm + repodata/ (repomd.xml.asc signed)
#
# Inputs (env):
#   PACKAGES_DIR  directory containing the channel's .deb and .rpm files
#   CHANNEL       stable | beta  (becomes the apt suite + rpm subdir)
#   OUT_DIR       output root (created; must not already contain a run)
#   GPG_KEY_ID    key id / fingerprint of the imported signing key
#
# Requires: apt-ftparchive (apt-utils), createrepo_c, rpmsign (rpm), gpg.
# The signing key must already be imported into the default keyring with no
# passphrase (CI imports it from a secret; see the workflow).
set -euo pipefail

: "${PACKAGES_DIR:?set PACKAGES_DIR to the directory of .deb/.rpm files}"
: "${CHANNEL:?set CHANNEL to stable or beta}"
: "${OUT_DIR:?set OUT_DIR}"
: "${GPG_KEY_ID:?set GPG_KEY_ID}"

case "$CHANNEL" in stable|beta) ;; *) echo "CHANNEL must be stable|beta, got: $CHANNEL" >&2; exit 2;; esac

shopt -s nullglob
DEBS=("$PACKAGES_DIR"/*.deb)
RPMS=("$PACKAGES_DIR"/*.rpm)
if [ ${#DEBS[@]} -eq 0 ] && [ ${#RPMS[@]} -eq 0 ]; then
  echo "no .deb or .rpm files in $PACKAGES_DIR — refusing to publish empty metadata" >&2
  exit 2
fi
echo "publishing channel=$CHANNEL: ${#DEBS[@]} deb(s), ${#RPMS[@]} rpm(s)"

# ── apt ────────────────────────────────────────────────────────────────────
if [ ${#DEBS[@]} -gt 0 ]; then
  APT="$OUT_DIR/apt"
  POOL="$APT/pool/$CHANNEL"
  DIST="$APT/dists/$CHANNEL"
  mkdir -p "$POOL" "$DIST/main/binary-amd64" "$DIST/main/binary-arm64"
  # Rename into Debian's `name_version_arch.deb` convention on the way into
  # the pool: apt-ftparchive's `--arch` filter matches the FILENAME pattern
  # `*_<arch>.deb`, so electron-builder's `OpenKnowledge-arm64.deb` shape
  # silently lands in NO per-arch index (empty Packages, "Unable to locate
  # package" — caught in the VM rehearsal). Fields come from the deb's own
  # control, so the rename can't drift from the metadata.
  for deb in "${DEBS[@]}"; do
    pkg=$(dpkg-deb -f "$deb" Package)
    ver=$(dpkg-deb -f "$deb" Version)
    arch=$(dpkg-deb -f "$deb" Architecture)
    cp "$deb" "$POOL/${pkg}_${ver}_${arch}.deb"
  done

  # apt-ftparchive emits Filename: relative to the directory it scans from —
  # run from the apt root so entries read `pool/<channel>/...`, matching the
  # deb line's URL base.
  (
    cd "$APT"
    for arch in amd64 arm64; do
      apt-ftparchive --arch "$arch" packages "pool/$CHANNEL" \
        > "dists/$CHANNEL/main/binary-$arch/Packages"
      # An empty index is structurally valid (signatures verify, URLs 200)
      # but users on that arch get "Unable to locate package" — exactly how
      # the filename-convention bug above first presented. Loud, not fatal:
      # a deliberately single-arch publish stays possible.
      if [ ! -s "dists/$CHANNEL/main/binary-$arch/Packages" ]; then
        echo "warning: Packages index for arch=$arch is EMPTY — no pool deb matched; expected only if this publish intentionally ships no $arch build" >&2
      fi
      gzip -9 -k -f "dists/$CHANNEL/main/binary-$arch/Packages"
    done
    apt-ftparchive \
      -o "APT::FTPArchive::Release::Origin=OpenKnowledge" \
      -o "APT::FTPArchive::Release::Label=OpenKnowledge" \
      -o "APT::FTPArchive::Release::Suite=$CHANNEL" \
      -o "APT::FTPArchive::Release::Codename=$CHANNEL" \
      -o "APT::FTPArchive::Release::Architectures=amd64 arm64" \
      -o "APT::FTPArchive::Release::Components=main" \
      release "dists/$CHANNEL" > "dists/$CHANNEL/Release"
  )

  # Both signature forms: InRelease (modern, single-fetch) + Release.gpg
  # (older apt). --batch/loopback because CI keys carry no passphrase.
  gpg --batch --yes --pinentry-mode loopback --local-user "$GPG_KEY_ID" \
    --clearsign -o "$DIST/InRelease" "$DIST/Release"
  gpg --batch --yes --pinentry-mode loopback --local-user "$GPG_KEY_ID" \
    --armor --detach-sign -o "$DIST/Release.gpg" "$DIST/Release"

  # signed-by= wants a binary keyring; the .asc is for humans + docs.
  gpg --export "$GPG_KEY_ID" > "$APT/openknowledge.gpg"
  gpg --armor --export "$GPG_KEY_ID" > "$APT/key.asc"
fi

# ── rpm ────────────────────────────────────────────────────────────────────
if [ ${#RPMS[@]} -gt 0 ]; then
  RPMROOT="$OUT_DIR/rpm"
  mkdir -p "$RPMROOT"
  # rpmsign resolves its key through the rpm macro, not a CLI flag.
  echo "%_gpg_name $GPG_KEY_ID" > "$HOME/.rpmmacros"

  for rpm in "${RPMS[@]}"; do
    base=$(basename "$rpm")
    case "$base" in
      *x86_64*) arch=x86_64 ;;
      *aarch64*|*arm64*) arch=aarch64 ;;
      *) echo "cannot infer arch from rpm filename: $base" >&2; exit 2 ;;
    esac
    dest="$RPMROOT/$CHANNEL/$arch"
    mkdir -p "$dest"
    cp "$rpm" "$dest/"
    # Package-level signature — dnf's default gpgcheck=1 verifies THIS, not
    # just the repo metadata signature.
    rpmsign --addsign "$dest/$base" >/dev/null
  done

  for dir in "$RPMROOT/$CHANNEL"/*/; do
    createrepo_c --general-compress-type=gz "$dir" >/dev/null
    # repo_gpgcheck=1 verifies this detached signature over the metadata index.
    gpg --batch --yes --pinentry-mode loopback --local-user "$GPG_KEY_ID" \
      --armor --detach-sign -o "$dir/repodata/repomd.xml.asc" "$dir/repodata/repomd.xml"
  done

  gpg --armor --export "$GPG_KEY_ID" > "$RPMROOT/key.asc"
fi

echo "repo tree ready under $OUT_DIR:"
find "$OUT_DIR" -type f | sort
