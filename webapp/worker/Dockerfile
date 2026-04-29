FROM python:3.12-slim

# We need the Docker CLI inside the worker so it can spawn the Strix sandbox image
# via the host's docker.sock (mounted at deploy time). On Debian 13 (trixie) the
# `docker.io` apt package no longer includes the `docker` CLI binary, so we pull
# the static binary directly from docker.com.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && ARCH="$(uname -m)" \
 && curl -fsSL "https://download.docker.com/linux/static/stable/${ARCH}/docker-27.3.1.tgz" \
      | tar -xz -C /tmp \
 && mv /tmp/docker/docker /usr/local/bin/docker \
 && rm -rf /tmp/docker \
 && docker --version

# Install uv for dependency management.
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

# --- Strix install ---------------------------------------------------------
#
# Default: install the latest published `strix-agent` from PyPI. Override
# the two ARGs at build time to install from our fork (or any fork / branch
# / tag / commit) without rewriting the Dockerfile:
#
#   docker build \
#     --build-arg STRIX_SOURCE=git \
#     --build-arg STRIX_REF=main \
#     -t strix-worker .
#
# STRIX_SOURCE accepts:
#   "pypi" (default) — `pip install strix-agent[==<STRIX_REF>]`
#   "git"            — install from `https://github.com/<STRIX_REPO>@<STRIX_REF>`
#
# STRIX_REPO defaults to our fork (ClatTribe/strix). STRIX_REF defaults to
# `main`. Pin a specific commit SHA for production rollouts so the build is
# reproducible (e.g. `--build-arg STRIX_REF=abc123def`).
#
# `git` is already on the image (installed in the apt block above) so the
# git+https install path needs no additional packages.
# Default to our fork pinned at a known-good commit. Builds are reproducible
# (the same SHA always produces the same image) and we control the rollout
# window for any change Strix lands upstream.
#
# When you land a wishlist item in the fork, bump STRIX_REF to the merge SHA
# on `ClatTribe/strix@main`. To temporarily fall back to upstream PyPI in
# an emergency: `--build-arg STRIX_SOURCE=pypi --build-arg STRIX_REF=`
ARG STRIX_SOURCE=git
ARG STRIX_REPO=ClatTribe/strix
ARG STRIX_REF=9fb101282f728e5135cb484e4e7557570f0846ef
RUN if [ "$STRIX_SOURCE" = "git" ]; then \
      pip install --no-cache-dir "git+https://github.com/${STRIX_REPO}@${STRIX_REF}"; \
    else \
      if [ "$STRIX_REF" = "main" ] || [ -z "$STRIX_REF" ]; then \
        pip install --no-cache-dir strix-agent; \
      else \
        pip install --no-cache-dir "strix-agent==${STRIX_REF}"; \
      fi; \
    fi \
 && python -c "import strix" \
 && echo "strix installed (source=$STRIX_SOURCE repo=$STRIX_REPO ref=$STRIX_REF)"

WORKDIR /app

COPY pyproject.toml ./
COPY src ./src

RUN uv pip install --system -e .

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# When GITHUB_TOKEN is set in the worker env, configure git to embed it into
# any github.com clone URL. Strix's git clone path doesn't read GITHUB_TOKEN
# directly, so the credential has to be wired through git itself.
# Falls through to plain `strix-worker` when GITHUB_TOKEN is unset.
RUN printf '%s\n' \
    '#!/bin/sh' \
    'set -eu' \
    'if [ -n "${GITHUB_TOKEN:-}" ]; then' \
    '  git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"' \
    'fi' \
    'exec "$@"' \
    > /usr/local/bin/entrypoint.sh \
 && chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["strix-worker"]
