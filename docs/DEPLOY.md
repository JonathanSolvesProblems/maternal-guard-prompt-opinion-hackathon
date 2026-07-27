# Deploying MaternalGuard

## Why deployment matters here

MaternalGuard is an inbound HTTP MCP server (Prompt Opinion calls `POST /mcp` server-to-server on every tool invocation). If it only runs on your laptop, a reviewer or teammate opening the marketplace listing at 2am finds a dead endpoint. **The reproduction guide, the CHAI Applied Model Card JSON referenced from every Provenance, and the MCP endpoint itself all need to be live 24/7 at a resolvable HTTPS URL.**

Everything below runs the app behind the OVH box's shared Traefik at `https://maternalguard.jonathanandrei.com`. Same pattern as `overtone.jonathanandrei.com` on the same box.

## What's on that one subdomain

| Route | Purpose |
|---|---|
| `POST /mcp` | The MCP server endpoint Prompt Opinion calls. Auth: `X-API-Key` header (see `MCP_API_KEY` in `.env`). |
| `GET /health` | Liveness JSON `{status:"healthy",...}`. Used by the Docker HEALTHCHECK. No auth. |
| `GET /guide` | Reviewer reproduction guide (dual-audience HTML page). |
| `GET /` | 302 → `/guide`. |
| `GET /dsi/model-card.json` | CHAI Applied Model Card JSON referenced from every AI-Provenance. |
| `GET /dsi/model-card.md` | Human-readable Markdown version. |
| `GET /debug/bearer` | Local-dev only. Returns 404 unless `MATERNALGUARD_DEBUG_ARGS=true`. Never enable in production. |

## Current deployment: OVH sandbox (live)

MaternalGuard runs on the OVH sandbox box, `51.161.82.166`, SSH as `jonathan`.

```
~/experimental-projects/maternalguard/
├── app/                  git clone of the public repo
├── docker-compose.yml    Traefik-labelled web service, capped CPU/memory
└── .env                  secrets, chmod 600
```

Same shape as `~/experimental-projects/overtone/`. Joins the shared `web` network so Traefik routes the subdomain in on `websecure` (443) with a Let's Encrypt cert obtained via HTTP-01. No ports are exposed publicly; traffic reaches the container only through Traefik.

**Deploy / update to the latest commit:**

```bash
ssh jonathan@51.161.82.166
cd ~/experimental-projects/maternalguard
git -C app pull
docker compose up -d --build
docker compose logs -f app      # expect: MaternalGuard MCP server listening on port 5000
```

**The one manual DNS step** (already done for the live deploy). Traefik cannot issue the TLS certificate until `maternalguard.jonathanandrei.com` resolves to the box. In the Hostinger DNS panel for `jonathanandrei.com`:

```
Type: A   Name: maternalguard   Value: 51.161.82.166   TTL: default
```

If the domain is behind Cloudflare, set the record to "DNS only" / grey cloud so the Let's Encrypt HTTP-01 challenge reaches the box.

## First-time setup on a fresh box

```bash
ssh jonathan@51.161.82.166
mkdir -p ~/experimental-projects/maternalguard
cd ~/experimental-projects/maternalguard
git clone https://github.com/JonathanSolvesProblems/maternal-guard-prompt-opinion-hackathon.git app
cp app/docker-compose.yml .

# Author the .env — see the "Required env vars" table below.
nano .env
chmod 600 .env

docker compose up -d --build
```

Wait ~90s the first time (npm install + Traefik cert issuance). Verify:

```bash
curl -fsS https://maternalguard.jonathanandrei.com/health | jq .
```

Should print `{"status":"healthy", ...}`.

## Required env vars

Every entry below goes into `~/experimental-projects/maternalguard/.env` on the box (chmod 600, never committed):

| Variable | Value | Notes |
|---|---|---|
| `MCP_API_KEY` | *(long random string)* | Sent by Prompt Opinion as `X-API-Key` on every `POST /mcp`. Match the value registered in Prompt Opinion → MCP Servers → your MaternalGuard entry. |
| `MATERNALGUARD_ENABLE_WRITEBACK` | `true` | Enables governed FHIR write-back. When `false`, `ProposeMaternalAction` and `UpdateMaternalAction` return dry-run previews only. |
| `MATERNALGUARD_ENABLE_PANEL_SCAN` | `true` | Registers the cohort-scan tool. |
| `MATERNALGUARD_BUNDLED_PATIENT_IDS` | *(empty or comma-separated FHIR Patient IDs)* | Bundled cohort for `MaternalPanelScan` / `OpenMaternalDashboard`. Leave empty to use the SHARP `X-Patient-ID` header only. |
| `MATERNALGUARD_PREFAB_RENDERER_MODE` | `cdn` | Serves the Prefab renderer via jsDelivr so Prompt Opinion's CSP accepts it. |

**Never set in production:**
```
MATERNALGUARD_DEBUG_ARGS=true
```

That flag prints the FHIR bearer JWT to stdout and exposes `/debug/bearer`. Fine for local development; a real leak surface anywhere else.

## Updating Prompt Opinion to point at the new URL

Once `https://maternalguard.jonathanandrei.com/health` returns 200, update your Prompt Opinion workspace:

1. Launchpad → Configuration → MCP Servers → click **MaternalGuard**.
2. **Endpoint** — change from your old ngrok URL to `https://maternalguard.jonathanandrei.com/mcp`.
3. Keep **Transport Type** = `Streamable HTTP`.
4. Keep **Authentication Type** = `API Key`, header `X-API-Key`, value = your `MCP_API_KEY` from `.env` above.
5. Click **Reconnect**. The dialog should show a green "Connected" indicator.
6. Kill your local `npm run dev` and stop the ngrok tunnel — running both at once won't corrupt state but wastes the ngrok tunnel.

## Verify it is live

- `curl -fsS https://maternalguard.jonathanandrei.com/health` → 200 JSON with tool list.
- `curl -fsS https://maternalguard.jonathanandrei.com/dsi/model-card.json | jq .intervention.version` → `"0.4.0"`.
- Open `https://maternalguard.jonathanandrei.com/guide` in a browser → dark-theme reproduction guide.
- In Prompt Opinion, send *"Draft the appropriate follow-up actions for the current patient."* against Maria Santos → dashboard renders with drafts + Approve/Reject.
- Click Approve → green banner top of refreshed huddle → task appears under Recently actioned with `accepted` badge.

## Alternatives (the app is portable)

MaternalGuard is a plain Docker web service with one inbound HTTP port and no runtime state (all persistence goes to the workspace FHIR store via the SHARP-supplied `X-FHIR-Server-URL`). Anything that can host a container will host it.

### Option A: Railway, from the dashboard

1. <https://railway.app> → **New Project** → **Deploy from GitHub repo** → pick this repo.
2. Railway detects the `Dockerfile`.
3. Under **Variables**, add every row from the env-vars table above.
4. Confirm the service exposes port 5000 (`PORT` env inherits Railway's assignment; the app respects it).
5. Add a custom domain if desired; point a CNAME at Railway's target.

### Option B: Render blueprint

Add a `render.yaml` next to `docker-compose.yml`:

```yaml
services:
  - type: web
    name: maternalguard
    env: docker
    plan: starter
    envVars:
      - key: MCP_API_KEY
        sync: false
      - key: MATERNALGUARD_ENABLE_WRITEBACK
        value: "true"
      # ... rest of the env-vars table
```

Then **New** → **Blueprint** → connect the repo. Same pattern as [Loose Ends](https://github.com/JonathanSolvesProblems/loose-ends).

### Option C: Fly.io

```bash
fly launch --no-deploy
fly secrets set MCP_API_KEY=... MATERNALGUARD_ENABLE_WRITEBACK=true \
                MATERNALGUARD_ENABLE_PANEL_SCAN=true \
                MATERNALGUARD_PREFAB_RENDERER_MODE=cdn
fly deploy
```

Add a custom subdomain with `fly certs add maternalguard.yourdomain.com` and follow the DNS records Fly prints.

## Notes

- **Docker healthcheck** ping `GET /health` every 30s. Compose restarts the container after 3 consecutive failures.
- **Compose resource caps** are conservative (512 MB, 1.0 CPU) because MaternalGuard is stateless and lightweight. Bump if you enable a large bundled cohort.
- **DSI version bumps** ship in the same commit that touches [static/dsi/model-card.json](../static/dsi/model-card.json) + [static/dsi/model-card.md](../static/dsi/model-card.md) + `MATERNALGUARD_DSI_VERSION` in [src/clinical/fhir-builders.ts](../src/clinical/fhir-builders.ts). This is the (b)(11) "ongoing maintenance" surface — don't skip any of the three.
- **Redeploy after a code change:** `git -C app pull && docker compose up -d --build`. Secrets in `.env` persist across rebuilds.
