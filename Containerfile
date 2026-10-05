# syntax=docker/dockerfile:1.7
#
# ok server + web UI, serving the project mounted at /data.
# Installs the published npm package instead of building the monorepo,
# so the image always matches the npm release it is tagged after.

# this has to be the digest of the multi-arch index, not of a single
# platform manifest (docker inspect gives you the latter)
ARG NODE_IMAGE=docker.io/library/node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG OK_VERSION

FROM ${NODE_IMAGE} AS runtime
ARG OK_VERSION

# git: the server won't boot without it (preflight in boot.ts)
# ca-certificates: the slim image has none
# tini: ok must not be PID 1, the lock code treats pid < 2 as invalid
# and `ok status` then reports its own server.lock as corrupt
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

RUN test -n "${OK_VERSION}" || (echo "OK_VERSION build-arg is required (e.g. --build-arg OK_VERSION=0.77.8)" >&2 && exit 1)
RUN npm install -g "@inkeep/open-knowledge@${OK_VERSION}" \
    && npm cache clean --force
RUN INSTALLED="$(ok --version | head -n1)" && [ "$INSTALLED" = "$OK_VERSION" ] || \
    (echo "installed ok --version '$INSTALLED' does not match requested OK_VERSION '$OK_VERSION'" >&2 && exit 1)

COPY --chown=node:node scripts/container-entrypoint.sh /usr/local/bin/container-entrypoint.sh
COPY --chown=node:node scripts/container-healthcheck.mjs /usr/local/bin/container-healthcheck
RUN chmod 0755 /usr/local/bin/container-entrypoint.sh /usr/local/bin/container-healthcheck

# not $HOME on purpose, ok init refuses to use the home dir as project root
RUN mkdir -p /data && chown node:node /data
ENV OK_PROJECT_DIR=/data
WORKDIR /data

USER node

LABEL org.opencontainers.image.title="open-knowledge" \
      org.opencontainers.image.description="Local-first, agent-friendly Markdown knowledge base (server + web UI)" \
      org.opencontainers.image.source="https://github.com/inkeep/open-knowledge" \
      org.opencontainers.image.licenses="GPL-3.0-or-later" \
      org.opencontainers.image.version="${OK_VERSION}"

ENV PORT=8080
EXPOSE 8080
ENV OK_BIND=0.0.0.0

# OK_ALLOW_EXTERNAL is left out on purpose. Whoever runs the image has to
# opt in to the non-loopback bind themselves.

# podman ignores this when the image was built with BuildKit, see
# containers/podman#18904. Podman users pass --health-cmd instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["container-healthcheck"]

# no --port here, it would win over PORT and break `-e PORT=...`
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/container-entrypoint.sh"]
CMD ["start"]
