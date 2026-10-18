# Status Monitor

A public status page for a fixed list of URLs.

- **Checker + API** (`api/`): one small Node.js 22 container (no npm dependencies, built-in `node:sqlite`) on an Oracle Cloud Always Free VM.
- **Database**: SQLite on a Docker volume, continuously replicated to Cloudflare R2 by [Litestream](https://litestream.io) 0.5, so it survives VM rebuilds.
- **Frontend** (`frontend/`): a static page on Cloudflare Pages that reads the API through a Cloudflare Tunnel.

```
 visitors ──► status.<domain>       Cloudflare Pages (frontend/, static)
                  │ fetch (CORS)
                  ▼
             status-api.<domain>    Cloudflare edge (15s cache on /api/*)
                  │ Cloudflare Tunnel (outbound-only from the VM)
                  ▼
 Oracle VM ── docker compose ─┬─ cloudflared ──► http://monitor:4040
                              └─ monitor (Node + Litestream)
                                    │  /data/status.db (volume)
                                    └─ replicates ──► R2 bucket
```

## Repo layout

| Path | What |
|---|---|
| `api/server.js` | HTTP API, check loop, shutdown |
| `api/checker.js` | One HTTP check, state classification, error messages |
| `api/db.js` | SQLite schema, queries, history bucketing, pruning |
| `api/monitors.js` | `MONITOR_URLS` parsing and stable ids |
| `api/test/` | `node:test` unit tests |
| `api/Dockerfile`, `entrypoint.sh`, `litestream.yml` | Image: restore → replicate → run app |
| `frontend/index.html` | Status page (vanilla HTML/CSS/JS) |
| `frontend/build-config.mjs` | Generates the untracked `frontend/config.js` (API URL, titles) from environment variables at build time |
| `deploy/` | `docker-compose.yml`, `.env.example`, `setup.sh` for the VM |
| `.github/workflows/image.yml` | Tests, then builds the `amd64` + `arm64` image and pushes it to GHCR |

## Configuration

All of it lives in `/opt/status-monitor/.env` on the server. `MONITOR_URLS` is the only place the list of sites is kept.

| Var | Default | Meaning |
|---|---|---|
| `MONITOR_URLS` | (required) | Entries separated by commas or newlines: `Name=https://…` or `https://…` (the name defaults to the host). Duplicates are ignored. An invalid entry stops startup with an error. A URL containing a comma must write it as `%2C`. |
| `ALLOWED_ORIGIN` | `*` | The status page's exact origin, e.g. `https://status.example.com` |
| `INTERVAL_SECONDS` | 30 | Seconds between check rounds |
| `SLOW_MS` | 2000 | Above this, a site that is up counts as slow |
| `TIMEOUT_MS` | 10000 | Per-request timeout |
| `RETENTION_DAYS` | 30 | Older checks are deleted hourly |
| `DATA_DIR` | `./data` (image: `/data`) | Directory holding `status.db` |
| `PORT` / `HOST` | 4040 / 0.0.0.0 | Listen address |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | (empty) | Litestream replica. Set all four or none; with none set, there's no replication. |
| `TUNNEL_TOKEN` | — | Used by the cloudflared container |

For example, `MONITOR_URLS="Website=https://example.com,Backend=https://api.example.com/health"` shows two rows, "Website" and "Backend".

The frontend's settings are environment variables. The Pages build command `node frontend/build-config.mjs` turns them into `frontend/config.js`, which is never committed:

| Setting | Default | Meaning |
|---|---|---|
| `STATUS_API` | `http://localhost:4040` locally; required on Pages | API base URL, e.g. `https://status-api.example.com` |
| `STATUS_TITLE` | `Status` | Title at the top of the page |
| `STATUS_TAB_TITLE` | `STATUS_TITLE` | Browser tab title. The current verdict goes in front of it, e.g. "Everything is up · Acme Status". |

Each site's id is the first 10 hex characters of the SHA-256 of its normalized URL. Reordering or renaming entries keeps their history. Changing a URL starts a new history, and the old rows expire after `RETENTION_DAYS`.

## API

The URLs themselves are never returned.

- `GET /api/status` (`Cache-Control: public, max-age=15`): every site's state (`up|slow|down|pending`), last check, 24h uptime and average, and the last 90 checks.
- `GET /api/history?id=<id>&range=24h|7d|30d` (`max-age=60`): fixed buckets of 5 min, 30 min or 2 h, with `{t, checks, up, avgMs, maxMs}`. Empty buckets are included. Unknown id → 404, bad range → 400.
- `GET /healthz` returns `200 ok` and is used by the Docker healthcheck.
- Every `/api/*` response carries `Access-Control-Allow-Origin: $ALLOWED_ORIGIN`, and `OPTIONS` preflight requests are answered.

`avgMs` and `maxMs` cover successful checks only, so a timeout doesn't distort the response-time chart.

## Local development

Requires Node ≥ 22.13.

```sh
cd api
npm test
MONITOR_URLS="GitHub=https://github.com,https://example.com" \
  ALLOWED_ORIGIN=http://localhost:8080 DATA_DIR=./data npm start

# in another shell: generate config.js (defaults to localhost:4040), then serve the page
node frontend/build-config.mjs
cd frontend && python3 -m http.server 8080
```

To build and run the container without R2:

```sh
docker build -t status-monitor:dev api
docker run --rm -p 4040:4040 -v status-data:/data \
  -e MONITOR_URLS=https://example.com -e ALLOWED_ORIGIN=http://localhost:8080 status-monitor:dev
```

To test replication against another S3-compatible store (MinIO, for example), also set `R2_ENDPOINT=http://host:9000` and the four `R2_*` variables. `R2_ENDPOINT` overrides the R2 URL derived from `R2_ACCOUNT_ID`.

## Deployment

One-time setup. Steps marked 👤 happen in a web dashboard.

1. 👤 **GitHub.** Push this repo. After the first `image` workflow run, open **Packages → the image → Package settings** and set the visibility to **Public**, so the VM can pull without logging in. Make sure the `image:` line in `deploy/docker-compose.yml` matches `ghcr.io/<owner>/<repo>` in lowercase.
2. 👤 **Cloudflare.**
   - Add the domain.
   - Create the R2 bucket `status-monitor-db` and an R2 API token with Object Read & Write access to that bucket only.
   - Create a tunnel (**Zero Trust → Networks → Tunnels**) with the public hostname `status-api.<domain>` and service `HTTP` → `monitor:4040`.
   - Create a Pages project from this repo with the build command `node frontend/build-config.mjs` and the output directory `frontend`, and add the custom domain `status.<domain>`.
   - Under **Settings → Variables and Secrets**, set `STATUS_API=https://status-api.<domain>` and, optionally, `STATUS_TITLE` and `STATUS_TAB_TITLE`. Then redeploy: variables only take effect on the next build.
3. 👤 **Oracle Cloud.**
   - Upgrade to Pay As You Go, so idle Always Free VMs aren't reclaimed, and set a $1 budget alert.
   - Create an Ubuntu 24.04 VM (`VM.Standard.E2.1.Micro` or Ampere A1) with your SSH key.
4. **Server:**
   ```sh
   scp -r deploy ubuntu@<ip>:~/status-monitor-deploy
   ssh ubuntu@<ip> 'cd ~/status-monitor-deploy && sudo ./setup.sh'
   ssh -t ubuntu@<ip> 'sudo nano /opt/status-monitor/.env'      # fill in secrets + MONITOR_URLS
   ssh ubuntu@<ip> 'cd /opt/status-monitor && sudo docker compose up -d'
   ```
5. 👤 **Cache rule.** In **Caching → Cache Rules**, match hostname `status-api.<domain>` and paths starting with `/api/`. Set it to **Eligible for cache**, with edge TTL **Use cache-control header if present**.

The VM needs no inbound ports apart from SSH, because the tunnel only connects outbound.

## Operations runbook

**Update to the latest image:**
```sh
cd /opt/status-monitor && sudo docker compose pull && sudo docker compose up -d
```

**Change the monitored sites:** edit `MONITOR_URLS` in `.env`, then `sudo docker compose up -d`. The container is recreated, and sites that are still listed keep their history.

**Logs and health:**
```sh
sudo docker compose ps                      # monitor should be "healthy"
sudo docker compose logs -f monitor         # state changes, Litestream sync/compaction
sudo docker compose logs -f cloudflared     # "Registered tunnel connection"
```

**Roll back to an earlier image:** set `image: ghcr.io/<owner>/<repo>:<short-sha>` in `docker-compose.yml`, then run `up -d`.

### Rebuilding the VM / restoring from R2

> ⚠️ **Single-writer rule:** only one running instance may replicate to a given bucket path. **Stop the old VM's container (`sudo docker compose down`) before starting a new one.** Two writers would corrupt the replica.

1. On the old VM, if it's still reachable, run `cd /opt/status-monitor && sudo docker compose down`. This flushes a final sync to R2.
2. Create the new VM, then copy `deploy/` over and run `setup.sh`.
3. Recreate `.env` with the same `R2_*` values, `TUNNEL_TOKEN` and `MONITOR_URLS`.
4. Run `sudo docker compose up -d`. On start, the entrypoint runs `litestream restore -if-db-not-exists -if-replica-exists`, so an empty volume is restored from R2. If the bucket is empty too, it starts fresh.
5. Check `sudo docker compose logs monitor`, then open the status page. History should be intact, minus at most about 30s of checks if the old VM died without a clean stop.

The same thing happens if the Docker volume is lost on an existing VM: `docker compose up -d` restores it.

### Restore drill log

| Date | Environment | Result |
|---|---|---|
| 2026-10-18 | Local container + MinIO (rehearsal) | Graceful stop and final sync OK. After `docker volume rm`, all 45 checks were restored and checking resumed. |
| _pending_ | Production VM + R2 | |

## Free-tier notes

- **R2:** Litestream 0.5 uploads one file per SQLite transaction. The checker therefore writes each round's results in **one** transaction, which gives about 2,880 L0 uploads a day at a 30s interval, whatever the number of sites. Add compaction (5m and 1h levels), a daily snapshot and 72h retention, and usage stays well under the 1M Class A operations a month in the free tier. The database is roughly 5 MB per site at 30 days of retention.
- **Cloudflare:** Pages, Tunnel and Cache Rules are free. The 15s edge cache means the origin sees at most about 4 status requests a minute, however many visitors there are.
- **Oracle:** the E2 Micro and Ampere A1 shapes are Always Free. The 2 GB swap file from `setup.sh` gives the 1 GB E2 Micro headroom.
