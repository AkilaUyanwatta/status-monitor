FROM litestream/litestream:0.5.17 AS litestream

FROM node:22.23.3-alpine

# ca-certificates for Litestream's TLS connections to R2 (Node bundles its own).
RUN apk add --no-cache ca-certificates
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream

WORKDIR /app
COPY package.json server.js db.js monitors.js checker.js ./
COPY litestream.yml /etc/litestream.yml
COPY --chmod=755 entrypoint.sh /app/entrypoint.sh

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=4040 \
    HOST=0.0.0.0

# The image's /data ownership is copied into a fresh named volume.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4040

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" > /dev/null || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
