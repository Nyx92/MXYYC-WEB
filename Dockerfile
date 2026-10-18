# Next.js 16 requires Node >= 20.9.
FROM node:22-slim

# openssl: Prisma's query engine needs libssl, which -slim images omit.
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl && \
    rm -rf /var/lib/apt/lists/*

# pnpm via corepack (version pinned by package.json "packageManager").
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Build and run as the unprivileged `node` user; it must own the app dir
# because `next start` writes to .next/cache at runtime.
WORKDIR /app
RUN chown node:node /app
USER node

# Dependencies first for layer caching. prisma/ is needed here because the
# postinstall script runs `prisma generate`.
COPY --chown=node:node package.json pnpm-lock.yaml .npmrc ./
COPY --chown=node:node prisma ./prisma
RUN pnpm install --frozen-lockfile

COPY --chown=node:node . .

# Note: src/lib/env.ts validates required env vars at import time, so the
# build environment must provide them (e.g. via --build-arg / build secrets).
RUN pnpm build

ENV PORT=3000
EXPOSE 3000
CMD ["pnpm", "exec", "next", "start", "-p", "3000"]
