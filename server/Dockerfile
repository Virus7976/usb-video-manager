# Local backend image. Debian slim, NOT Alpine: the wider app depends on ffmpeg and native modules
# that want glibc, and musl is a recurring source of the kind of silent breakage this project cannot
# afford. Nothing here needs those yet — this keeps the base consistent for when it does.
FROM node:22-bookworm-slim AS deps
WORKDIR /app/server
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
# core/ is shared with the desktop app and has NO dependencies — that is a rule, not a coincidence.
COPY core ./core
COPY server ./server
COPY --from=deps /app/server/node_modules ./server/node_modules
# Never run as root. The store is mounted read-only anyway (see docker-compose.yml), but the two
# together mean a compromise of this process cannot write to his footage or his metadata.
USER node
EXPOSE 8787
# UVD_TOKEN is deliberately NOT defaulted — the server refuses to start without one rather than
# serving an index of who is in his footage to the whole network.
CMD ["node", "server/server.js"]
