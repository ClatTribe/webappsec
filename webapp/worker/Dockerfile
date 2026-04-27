FROM python:3.12-slim

# We need the Docker CLI inside the worker so it can spawn the Strix sandbox image.
# The worker container itself is mounted to the host's docker.sock at deploy time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl ca-certificates git \
      docker.io \
 && rm -rf /var/lib/apt/lists/*

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

CMD ["strix-worker"]
