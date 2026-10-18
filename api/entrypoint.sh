#!/bin/sh
# Restore the database from R2 if needed, then run the app under Litestream.
set -eu

DATA_DIR="${DATA_DIR:-/data}"
export DATA_DIR
DB="$DATA_DIR/status.db"
CONFIG=/etc/litestream.yml
APP="node --disable-warning=ExperimentalWarning /app/server.js"

set_count=0
for v in R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_BUCKET; do
  eval "val=\${$v:-}"
  [ -n "$val" ] && set_count=$((set_count + 1))
done

if [ "$set_count" -eq 0 ]; then
  echo "entrypoint: R2 not configured, running without replication"
  exec $APP
fi
if [ "$set_count" -ne 4 ]; then
  echo "entrypoint: set all of R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (or none)" >&2
  exit 1
fi

# R2_ENDPOINT is only overridden for local testing against another S3 store.
R2_ENDPOINT="${R2_ENDPOINT:-https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com}"
export R2_ENDPOINT

echo "entrypoint: restoring $DB from replica if missing"
litestream restore -config "$CONFIG" -if-db-not-exists -if-replica-exists "$DB"

echo "entrypoint: starting replication"
exec litestream replicate -config "$CONFIG" -exec "$APP"
