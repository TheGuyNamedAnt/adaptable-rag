# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json eslint.config.js .prettierrc.json ./
COPY scripts ./scripts
COPY src ./src
COPY profiles ./profiles
COPY README.md ./
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --system rag \
  && useradd --system --gid rag --home-dir /app --shell /usr/sbin/nologin rag \
  && mkdir -p /data \
  && chown -R rag:rag /app /data

COPY --from=build --chown=rag:rag /app/package.json /app/package-lock.json ./
COPY --from=build --chown=rag:rag /app/node_modules ./node_modules
COPY --from=build --chown=rag:rag /app/dist ./dist
COPY --from=build --chown=rag:rag /app/profiles ./profiles

USER rag
EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/ready').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/runtime/production-cli.js", "serve"]
