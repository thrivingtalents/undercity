# ---------------------------------------------------------------- prod deps
# better-sqlite3 is a native module, so build it against the same Node that
# will run it. Debian slim rather than Alpine: the prebuilt binaries are glibc.
FROM node:22-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---------------------------------------------------------------- paper kit
# The thirteen printable documents are generated HERE, from the same commit
# that produced content/*.json. That is what makes the admin panel's "kit
# matches this server" badge a fact rather than a hope: both halves of the
# pipeline run once, together, from one matrix.
#
# python3-openpyxl from apt rather than pip: Debian marks its Python
# externally-managed (PEP 668), and the apt package is exactly what we need.
FROM node:22-slim AS kit
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-openpyxl make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci                                  # includes docx, the renderer
COPY tools ./tools
COPY content ./content
RUN mkdir -p kit && npm run kit

# ---------------------------------------------------------------- runtime
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=kit  /app/kit ./kit
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY content ./content
COPY config ./config
COPY public ./public
COPY scripts ./scripts

# No python3, no docx, no matrix in the runtime image: the kit is already
# built, and nothing here regenerates it. Smaller image, no exec surface.
ENV DATA_DIR=/var/data
ENV KIT_DIR=/app/kit
ENV MODE=hosted
ENV PORT=3000
EXPOSE 3000

# Drop privileges: the node image ships a non-root `node` user.
RUN mkdir -p /var/data && chown -R node:node /var/data /app
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
