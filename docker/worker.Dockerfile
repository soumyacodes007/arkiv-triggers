# The Arkiv Triggers worker as a container. Build from the repo root:
#   docker build -f docker/worker.Dockerfile -t arkiv-triggers-worker .
#   docker run --env-file .env -p 8080:8080 arkiv-triggers-worker
# Settings come from the environment only (see .env.example); no key is ever baked into the image.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

# Runtime dependencies only: viem (a peer dependency) comes along; tsup's native binaries and
# typescript (an optional peer of the Arkiv SDK) do not.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional --ignore-scripts && test -d node_modules/viem

FROM node:22-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "dist/cli.js"]
