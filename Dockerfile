# Stage 1: Build the application
FROM node:26-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Corepack is no longer bundled with Node.js 25+, so pnpm is installed
# directly. Keep this version in sync with `packageManager` in package.json.
RUN npm install -g pnpm@11.22.0

WORKDIR /app
# pnpm-workspace.yaml carries the `allowBuilds` allow-list. Without it pnpm 11
# fails the install outright with ERR_PNPM_IGNORED_BUILDS, so it has to be in
# the image alongside the manifest and the lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src

FROM base AS prod-deps
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

FROM base AS build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm run build

# Stage 2: Production image using Distroless
FROM gcr.io/distroless/nodejs26-debian13 AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY drizzle ./drizzle
# Read at runtime for the NATS service's version (`transports/nats/metaService.ts`).
COPY package.json ./

EXPOSE 3030

CMD ["dist/index.js"]

