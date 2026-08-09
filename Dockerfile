# syntax=docker/dockerfile:1.6

# ============================================================================
# SHARED BASE IMAGES
# ============================================================================
FROM node:22-slim AS runtime-base

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production
ENV PORT=3001
ENV PYTHON_PATH=/usr/bin/python3
ENV DATA_DIR=/app/data
ENV CODEX_HOME=/app/data/codex-home
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PATH=/root/.local/bin:${PATH}
ARG CODEX_CLI_VERSION=0.120.0
ARG CLAUDE_CODE_CLI_VERSION=2.1.220

# Install runtime dependencies shared by build and production stages.
# poppler-utils provides `pdftotext`, used by services/cv/pdftotext-diff.ts to
# verify content equivalence between the original CV PDF and the templated PDF
# at upload time (5e CV substrate gate).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    python3 python3-minimal libpython3.11-minimal \
    python3-pip \
    libgtk-3-0 libgtk-3-common \
    libdbus-glib-1-2 libxt6 libx11-xcb1 libasound2 \
    poppler-utils \
    curl && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# LibreOffice Writer (headless, no Java — W1-verified sufficient for
# docx→pdf) + metric-compatible fonts (Carlito→Calibri, Caladea→Cambria,
# Liberation→Arial/Times) for Word-CV preview conversion. Lives in
# runtime-base rather than the production stage so the tools image built
# from build-sources can exercise the real converter in the test suite —
# same reasoning as poppler-utils above.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice-core libreoffice-writer \
    fonts-crosextra-carlito fonts-crosextra-caladea fonts-liberation \
    fontconfig python3-uno && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# unoserver wraps the LibreOffice UNO API in a long-lived conversion daemon.
# Cold `soffice --convert-to` is NOT a viable fallback: real-world CVs can
# hang it indefinitely while converting fine through the daemon (W1 finding).
RUN pip3 install --break-system-packages unoserver

# Install Codex CLI for local app-server based inference.
RUN npm install -g @openai/codex@${CODEX_CLI_VERSION}

# Install Claude Code CLI for the headless `claude -p` provider. Unlike Codex
# it needs no persisted auth home: the provider authenticates purely through
# CLAUDE_CODE_OAUTH_TOKEN and spawns each query with sessions, settings and
# MCP config disabled.
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_CLI_VERSION}
# Surface the build-time pin to the runtime so the Settings CLI panel can show
# which version the image (and the provider's flag set) was verified against.
ENV CLAUDE_CODE_CLI_PINNED=${CLAUDE_CODE_CLI_VERSION}

WORKDIR /app

FROM runtime-base AS build-base

# Install compiler toolchain only for build-oriented stages.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# ============================================================================
# BUILD INPUT STAGES
# ============================================================================
FROM build-base AS python-deps

# Install Python dependencies with pip cache.
RUN --mount=type=cache,target=/root/.cache/pip \
    pip3 install --break-system-packages playwright python-jobspy

# Install Firefox for Python Playwright.
RUN python3 -m playwright install firefox

FROM build-base AS node-deps

# Copy package files for dependency installation.
COPY package*.json ./
COPY scripts/camoufox-fetch.mjs ./scripts/camoufox-fetch.mjs
COPY shared/package*.json ./shared/
COPY orchestrator/package*.json ./orchestrator/
COPY extractors/hiringcafe/package*.json ./extractors/hiringcafe/
COPY extractors/startupjobs/package*.json ./extractors/startupjobs/
COPY extractors/workingnomads/package*.json ./extractors/workingnomads/

# Install Node dependencies with npm cache (dev deps needed for build).
RUN --mount=type=cache,target=/root/.npm \
    npm install --workspaces --include-workspace-root --include=dev \
    --no-audit --no-fund --progress=false

# Install the Firefox revision that the Node Playwright package version
# expects, alongside the Python-installed Firefox that already lives in
# /ms-playwright. The revisions live in disjoint firefox-<N>/ subdirs so
# neither overwrites the other. Needed because orchestrator's manual-fetch
# tier-2 fallback calls firefox.launch() without an explicit executablePath.
RUN npx playwright install firefox

# Fetch Camoufox binaries before copying source to keep the download cached.
# Anonymous GitHub fetch — no token plumbing into the build by design.
RUN node ./scripts/camoufox-fetch.mjs

FROM node-deps AS build-sources

COPY shared ./shared
COPY orchestrator ./orchestrator
COPY extractors/hiringcafe ./extractors/hiringcafe
COPY extractors/jobspy ./extractors/jobspy
COPY extractors/startupjobs ./extractors/startupjobs
COPY extractors/workingnomads ./extractors/workingnomads

# ============================================================================
# PARALLEL BUILD STAGES
# ============================================================================
FROM build-sources AS client-build

WORKDIR /app/orchestrator
RUN npm run build:client

# ============================================================================
# PRODUCTION INPUT STAGES
# ============================================================================
FROM runtime-base AS runtime-node-deps

# Copy package files for production dependency installation.
COPY package*.json ./
COPY shared/package*.json ./shared/
COPY orchestrator/package*.json ./orchestrator/
COPY extractors/hiringcafe/package*.json ./extractors/hiringcafe/
COPY extractors/startupjobs/package*.json ./extractors/startupjobs/
COPY extractors/workingnomads/package*.json ./extractors/workingnomads/

# Install production Node dependencies only.
RUN --mount=type=cache,target=/root/.npm \
    npm install --workspaces --include-workspace-root --omit=dev \
    --no-audit --no-fund --progress=false

FROM runtime-base AS tectonic

ARG TARGETARCH
ENV TECTONIC_VERSION=0.15.0

# Install Tectonic for local LaTeX resume rendering.
# Upstream publishes a musl Linux ARM build but not a glibc one, so map
# Docker's target architecture to the matching release asset explicitly.
RUN set -eux; \
    case "${TARGETARCH}" in \
        amd64) tectonic_arch="x86_64-unknown-linux-gnu" ;; \
        arm64) tectonic_arch="aarch64-unknown-linux-musl" ;; \
        *) echo "Unsupported TARGETARCH for Tectonic: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    tectonic_asset="tectonic-${TECTONIC_VERSION}-${tectonic_arch}.tar.gz"; \
    curl --proto '=https' --tlsv1.2 -fsSL \
        "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/${tectonic_asset}" \
        -o /tmp/tectonic.tar.gz; \
    tar -xzf /tmp/tectonic.tar.gz -C /tmp; \
    install -m 0755 "/tmp/tectonic" /usr/local/bin/tectonic; \
    rm -f /tmp/tectonic.tar.gz /tmp/tectonic

# ============================================================================
# PRODUCTION STAGE
# ============================================================================
FROM runtime-node-deps AS production

# Copy production-only runtime assets from sibling stages.
COPY --from=tectonic /usr/local/bin/tectonic /usr/local/bin/tectonic
COPY --from=python-deps /usr/local/lib/python3.11/dist-packages /usr/local/lib/python3.11/dist-packages
COPY --from=python-deps /ms-playwright /ms-playwright
# Node-installed Firefox revision (manual-fetch tier-2 fallback). Sits in a
# disjoint firefox-<rev>/ subdir from python-deps' install above, so this
# COPY adds the Node revision without overwriting Python's.
COPY --from=node-deps /ms-playwright /ms-playwright
COPY --from=node-deps /root/.cache/camoufox /root/.cache/camoufox

# Copy built assets and runtime source code.
COPY --from=client-build /app/orchestrator/dist ./orchestrator/dist
COPY shared ./shared
COPY orchestrator ./orchestrator
COPY extractors/hiringcafe ./extractors/hiringcafe
COPY extractors/jobspy ./extractors/jobspy
COPY extractors/startupjobs ./extractors/startupjobs
COPY extractors/workingnomads ./extractors/workingnomads

# Bake user-editable prompt YAMLs into the image as a fallback so a fresh
# `docker compose up` works even before the host-side bind mount is wired.
COPY prompts ./prompts

ENV PROMPTS_DIR=/app/prompts

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3001/health || exit 1

WORKDIR /app/orchestrator
CMD ["sh", "-c", "mkdir -p \"$CODEX_HOME\" && npx tsx src/server/db/migrate.ts && npm run start"]
