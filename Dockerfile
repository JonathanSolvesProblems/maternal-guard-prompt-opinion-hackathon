# MaternalGuard MCP server image.
#
# Runs the Node/Express MCP server that Prompt Opinion connects to. Also
# serves the static reviewer reproduction guide and the CHAI Applied Model
# Card JSON/MD referenced from every Provenance the server writes.
#
# Deployed behind the OVH box's Traefik at https://maternalguard.jonathanandrei.com
# (see docs/DEPLOY.md). Traefik terminates TLS; the container listens on plain
# HTTP inside the shared `web` network.

FROM node:22-alpine

# curl is only used by the HEALTHCHECK below; not needed at runtime.
RUN apk add --no-cache curl

WORKDIR /app

# Copy the lockfile FIRST for layer caching. `npm ci` is deterministic — it
# refuses to run if package.json and package-lock.json disagree, so a corrupt
# lockfile fails the build instead of silently drifting.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=5000
EXPOSE 5000

# Liveness: /health returns {status:"healthy",...} without touching FHIR, so
# it is a clean signal that the Node process is alive and the HTTP server is
# routing. Traefik / compose restarts the container if this fails repeatedly.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://localhost:${PORT:-5000}/health" >/dev/null || exit 1

CMD ["npm", "run", "start"]
