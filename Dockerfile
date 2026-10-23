# syntax=docker/dockerfile:1
ARG BUN_VERSION=1.4.3

# ---- build: instala dependências de forma reprodutível ----
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY docs ./docs
COPY scripts/migrate.ts ./scripts/migrate.ts
COPY mikro-orm.config.ts ./mikro-orm.config.ts
RUN bun install --frozen-lockfile --production

# ---- runtime: imagem enxuta, usuário não-root ----
FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/package.json ./package.json
COPY --from=build --chown=bun:bun /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=bun:bun /app/src ./src
COPY --from=build --chown=bun:bun /app/docs ./docs
COPY --from=build --chown=bun:bun /app/scripts ./scripts
COPY --from=build --chown=bun:bun /app/mikro-orm.config.ts ./mikro-orm.config.ts
USER bun
EXPOSE 3000
CMD ["bun", "src/main.ts"]
