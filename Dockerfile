# syntax=docker/dockerfile:1

# --- deps ---
FROM node:22-alpine AS deps
WORKDIR /app
# pnpm-workspace.yaml is required: it holds the build-script approvals and
# `nodeLinker: hoisted`, without which the image builds and then fails to boot.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

# --- build ---
FROM node:22-alpine AS build
WORKDIR /app
ARG GIT_REVISION=dev
ENV GIT_REVISION=$GIT_REVISION
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN corepack enable && pnpm build
# The migrator is not part of the Next build: `output: 'standalone'` only traces
# what the application imports, so it is bundled separately.
RUN pnpm exec esbuild lib/db/migrate.ts \
      --bundle --platform=node --format=cjs --outfile=dist/migrate.cjs

# --- runtime ---
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

ARG GIT_REVISION=unknown
ENV GIT_REVISION=$GIT_REVISION

RUN addgroup -S app && adduser -S app -G app
COPY --from=build /app/.next/standalone ./
# Static assets and public/ are not traced into the standalone output.
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/lib/db/migrations ./lib/db/migrations
COPY --from=build /app/dist/migrate.cjs ./dist/migrate.cjs
COPY docker-entrypoint.sh /usr/local/bin/
# COPY preserves the source file's mode; set the bit here so a commit without it
# cannot produce a container that exits with `permission denied`.
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
USER app
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
