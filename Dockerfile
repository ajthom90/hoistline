# syntax=docker/dockerfile:1
# Hoistline hub. Build: docker build -t hoistline-hub .

FROM node:22-bookworm-slim AS build
# Toolchain for better-sqlite3 when no prebuilt binary matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/hub/package.json packages/hub/
COPY packages/agent/package.json packages/agent/
RUN pnpm install --frozen-lockfile
COPY packages/protocol packages/protocol
COPY packages/hub packages/hub
RUN pnpm --filter @hoistline/protocol --filter @hoistline/hub build
# The hub with production dependencies only (better-sqlite3 built here), and its dist.
RUN pnpm --filter @hoistline/hub deploy --prod /out

FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*
RUN groupadd --gid 10001 hoistline \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin hoistline \
  && mkdir /data \
  && chown 10001:10001 /data
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/dist ./dist
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/hoistline.db
USER 10001:10001
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --start-interval=2s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/.well-known/oauth-authorization-server').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
