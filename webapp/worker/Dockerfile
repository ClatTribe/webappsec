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

# Install Strix from PyPI (kept independent from the worker code).
RUN pip install --no-cache-dir strix-agent

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
