#!/usr/bin/env bash
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

if [ ${#DEBS[@]} -gt 0 ]; then
  APT="$OUT_DIR/apt"
  POOL="$APT/pool/$CHANNEL"
  DIST="$APT/dists/$CHANNEL"
  mkdir -p "$POOL" "$DIST/main/binary-amd64" "$DIST/main/binary-arm64"
  for deb in "${DEBS[@]}"; do
    pkg=$(dpkg-deb -f "$deb" Package)
    ver=$(dpkg-deb -f "$deb" Version)
    arch=$(dpkg-deb -f "$deb" Architecture)
    cp "$deb" "$POOL/${pkg}_${ver}_${arch}.deb"
  done

  (
    cd "$APT"
    for arch in amd64 arm64; do
      apt-ftparchive --arch "$arch" packages "pool/$CHANNEL" \
        > "dists/$CHANNEL/main/binary-$arch/Packages"
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

  gpg --batch --yes --pinentry-mode loopback --local-user "$GPG_KEY_ID" \
    --clearsign -o "$DIST/InRelease" "$DIST/Release"
  gpg --batch --yes --pinentry-mode loopback --local-user "$GPG_KEY_ID" \
    --armor --detach-sign -o "$DIST/Release.gpg" "$DIST/Release"

  gpg --export "$GPG_KEY_ID" > "$APT/openknowledge.gpg"
  gpg --armor --export "$GPG_KEY_ID" > "$APT/key.asc"
fi

if [ ${#RPMS[@]} -gt 0 ]; then
  RPMROOT="$OUT_DIR/rpm"
  mkdir -p "$RPMROOT"
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
    rpmsign --addsign "$dest/$base" >/dev/null
  done

  for dir in "$RPMROOT/$CHANNEL"/*/; do
    createrepo_c --general-compress-type=gz "$dir" >/dev/null
    gpg --batch --yes --pinentry-mode loopback --local-user "$GPG_KEY_ID" \
      --armor --detach-sign -o "$dir/repodata/repomd.xml.asc" "$dir/repodata/repomd.xml"
  done

  gpg --armor --export "$GPG_KEY_ID" > "$RPMROOT/key.asc"
fi

echo "repo tree ready under $OUT_DIR:"
find "$OUT_DIR" -type f | sort
