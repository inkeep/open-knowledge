# Linux package repository (apt + rpm)

> **Status: PARKED, not wired into the release cadence.** Linux updates ship
> in-app instead: electron-updater's `DebUpdater`/`RpmUpdater` download the
> new package from the GitHub release feed and install it via `pkexec` (see
> `RELEASES.md` § "Linux updates (no package repository)"). This repo
> machinery is kept for a possible future repo-based channel; none of its
> operator setup (GPG key, R2 bucket, `packages.openknowledge.ai`) was
> provisioned.

Self-hosted apt/dnf repository for the OpenKnowledge Linux desktop packages,
served as **static files** from an R2 bucket behind
`packages.openknowledge.ai`. There is no server component: `apt` and `dnf` do
all the work client-side; our job is generating correctly-signed metadata and
uploading it.

Historical context: this repository was designed after AppImage was removed
because its FUSE 2 dependency is absent from current distributions. It is
parked now that deb and rpm builds update in-app from the GitHub release feed;
the repository machinery remains available if system-package-manager delivery
is revisited.

- Generator: [`publish-linux-repo.sh`](./publish-linux-repo.sh) — stateless,
  emits metadata for exactly the packages it is given (latest-only per
  channel). Older versions stay downloadable from their GitHub Releases.
- Publisher: [`.github/workflows/publish-linux-repo.yml`](../../.github/workflows/publish-linux-repo.yml)
  — `workflow_dispatch` **on the mirror** (`inkeep/open-knowledge`): give it a
  release tag + channel; it downloads the release's `.deb`/`.rpm` assets,
  generates, signs, syncs.

## One-time setup (operator, ~30 min)

1. **Signing key** (do this on a trusted machine, not CI):

   ```bash
   gpg --batch --gen-key <<'EOF'
   %no-protection
   Key-Type: RSA
   Key-Length: 4096
   Key-Usage: sign
   Name-Real: OpenKnowledge Package Signing
   Name-Email: support@inkeep.com
   Expire-Date: 0
   %commit
   EOF
   gpg --armor --export-secret-keys support@inkeep.com > ok-packages-signing.key
   ```

   `%no-protection` (no passphrase) is deliberate: the key's only home is the
   GitHub secret store and CI signing must be non-interactive. Keep an
   offline copy somewhere durable (losing it means every user must re-run the
   install one-liner against a new key).

2. **Bucket + domain**: create an R2 bucket (suggested name `ok-packages`),
   connect the custom domain `packages.openknowledge.ai` (R2 → bucket →
   Settings → Custom Domains; this also fronts it with Cloudflare's CDN), and
   create an R2 API token scoped to that bucket (Object Read & Write).

3. **Secrets + variable on the mirror** (`inkeep/open-knowledge`):

   ```bash
   gh secret set LINUX_REPO_GPG_PRIVATE_KEY  --repo inkeep/open-knowledge < ok-packages-signing.key
   gh secret set LINUX_REPO_R2_ACCESS_KEY_ID --repo inkeep/open-knowledge
   gh secret set LINUX_REPO_R2_SECRET_ACCESS_KEY --repo inkeep/open-knowledge
   gh secret set LINUX_REPO_R2_ENDPOINT      --repo inkeep/open-knowledge   # https://<account-id>.r2.cloudflarestorage.com
   gh variable set LINUX_REPO_BUCKET         --repo inkeep/open-knowledge --body ok-packages
   ```

4. Shred the local `ok-packages-signing.key` copy once the offline backup +
   secret exist.

## Publishing

Prerequisite: the release tag must carry the `.deb` and `.rpm` assets. The
standard desktop release flow attaches the Windows and Linux installers at
release-cut time; this repository publisher consumes those release assets.

```bash
gh workflow run publish-linux-repo.yml --repo inkeep/open-knowledge \
  -f tag=v0.46.0 -f channel=stable            # add -f dry_run=true to rehearse
```

Re-running for the same tag is idempotent. Publishing `beta` and `stable`
never touch each other's prefixes.

## Client install

Debian/Ubuntu:

```bash
sudo curl -fsSLo /usr/share/keyrings/openknowledge.gpg https://packages.openknowledge.ai/apt/openknowledge.gpg
echo "deb [signed-by=/usr/share/keyrings/openknowledge.gpg] https://packages.openknowledge.ai/apt stable main" | sudo tee /etc/apt/sources.list.d/openknowledge.list
sudo apt update && sudo apt install openknowledge
```

Fedora/RHEL:

```bash
sudo tee /etc/yum.repos.d/openknowledge.repo <<'EOF'
[openknowledge]
name=OpenKnowledge
baseurl=https://packages.openknowledge.ai/rpm/stable/$basearch/
enabled=1
gpgcheck=1
repo_gpgcheck=1
gpgkey=https://packages.openknowledge.ai/rpm/key.asc
EOF
sudo dnf install openknowledge
```

Beta channel: replace `stable` with `beta` in either snippet.

## Design notes / known caveats

- **Latest-only, stateless.** Each publish regenerates a channel's metadata
  from scratch and prunes the previous version from the bucket (`--delete`
  scoped per channel prefix). No aptly/reprepro database exists anywhere.
  Sync order (packages before metadata) keeps a live repo from referencing
  not-yet-uploaded files.
- **Beta→stable version ordering (deb).** dpkg parses `0.46.0-beta.4` as
  upstream `0.46.0` + revision `beta.4`, which sorts ABOVE plain `0.46.0`.
  Within one suite versions increase monotonically, so users tracking a
  single channel are fine; a user switching beta→stable at the same upstream
  version won't see the stable build as an upgrade. The Debian-idiomatic fix
  is emitting `0.46.0~beta.4` (`~` sorts below everything) in the deb Version
  field at build time — a future electron-builder `fpm`-args refinement, not
  done yet.
- **Key rotation** = generate a new key, publish BOTH public keys for a
  transition window, sign with the new one, update docs. There is no
  in-band rotation for `signed-by=` keyrings; treat the key as long-lived.
- **rpm packages are signed individually** (`rpmsign`) AND the repo metadata
  is signed (`repomd.xml.asc`) — dnf's `gpgcheck=1` + `repo_gpgcheck=1`
  verify both.

## Remaining integration (not this change)

- Chain `publish-linux-repo` into the release cadence (beta on every cut,
  stable on promote) instead of manual dispatch.
- Docs-site install page + `openknowledge.ai/download/linux` pointing at the
  one-liners above.
