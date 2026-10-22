# ---- build ----
# the output is static files, so it is built once on the runner's own platform - npm under QEMU emulation
# (the arm64 image) is slow and can hang
# Node is pinned to a patch release so a security update is a visible change (see docs/releases)
FROM --platform=$BUILDPLATFORM node:22.23.4-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY . .
# shown in the footer; CI passes the release tag (empty = the version in package.json)
ARG APP_VERSION=""
RUN APP_VERSION="$APP_VERSION" npm run build

# ---- runtime: the built app + the backend (Node, no dependencies), non-root on :8080 ----
FROM node:22.23.4-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=/app/dist \
    LYNX_URL=https://lynx.iotopen.se \
    ALLOWED_LYNX_HOSTS=lynx.iotopen.se \
    APP_TITLE="App Management" \
    API_MODE=proxy \
    CUSTOM_SERVERS=true \
    GITHUB_TOPIC=iotopen-edge-app \
    EDGE_CLIENT_IMAGE=ghcr.io/iotopen/edge-client:latest
COPY package.json ./
COPY shared ./shared
COPY server ./server
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server/index.mjs"]
