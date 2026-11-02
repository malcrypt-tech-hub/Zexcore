> **Legacy design notes.** This document describes the earlier self-hosted PostgreSQL/Fastify design (`apps/api`, `packages/*`), which is not what production runs. The live product is the Firebase + Cloudflare Worker build described in the [README](../README.md) and [launch runbook](launch-runbook.md). Nothing here (including encryption, RLS or queue claims) should be read as a description of the live service.

# ZexCore Deployment Guide

This guide covers deploying the **ZexCore Platform** — the Firebase Hosting frontend dashboard and the Node.js Fastify API server with PostgreSQL 17.

---

## Architecture Overview

```mermaid
graph LR
    User[Client Browser] -->|HTTPS| Firebase[Firebase Hosting: zexcore-5d6c0.web.app]
    Firebase -->|Auth| FbAuth[Firebase Auth: Google / Email]
    User -->|REST / WS| API[ZexCore Fastify API]
    API -->|Session-Bound RLS| DB[(PostgreSQL 17 Database)]
```

---

## 1. Frontend Dashboard (Live on Firebase Hosting)

The frontend is already configured and deployed at:
- **Primary:** `https://zexcore-5d6c0.web.app`
- **Secondary:** `https://zexcore-5d6c0.firebaseapp.com`

To redeploy after making changes:
```bash
npm run deploy
```

---

## 2. Backend API Deployment

The ZexCore API server is containerized and ready for 1-click deployment.

### Option A: Railway (Fastest 1-Click)
1. Install Railway CLI or connect via GitHub: `https://railway.app`
2. Create a **New Project** → **Provision PostgreSQL**.
3. Add a **New Service** from your GitHub repo (`malcrypt-tech-hub/Zexcore`).
4. Railway will automatically detect the [Dockerfile](file:///home/mal4crypt404/ZexCore/Dockerfile) and [railway.json](file:///home/mal4crypt404/ZexCore/railway.json).
5. Add the following Environment Variables:
   - `DATABASE_URL`: `${{Postgres.DATABASE_URL}}`
   - `NODE_ENV`: `production`
   - `CORS_ORIGIN`: `https://zexcore-5d6c0.web.app,https://zexcore-5d6c0.firebaseapp.com`
   - `JWT_SECRET`: Generate a 32+ character random secret
   - `PORT`: `3000`

### Option B: Render Blueprint
1. Connect your repo in Render (`https://render.com`).
2. Select **New** → **Blueprint** and point to the repository.
3. Render reads [render.yaml](file:///home/mal4crypt404/ZexCore/render.yaml) and automatically creates:
   - A managed PostgreSQL database (`zexcore-db`)
   - A Docker web service (`zexcore-api`) with healthchecks and auto-injected database credentials.

### Option C: Self-Hosted Docker Compose (VPS / DigitalOcean / AWS EC2)
Run the entire production stack (API + Postgres 17) in one command:
```bash
docker compose up -d
```
Verify the healthcheck:
```bash
curl http://localhost:3000/api/health
# {"status":"ok","version":"0.1.0"}
```

---

## 3. Database Initialization & Migrations

When connecting to a fresh production database (e.g. Supabase, Neon, or Railway Postgres):

```bash
# 1. Generate migrations (if schema changed)
pnpm db:generate

# 2. Push tables and RLS policies
pnpm db:migrate

# 3. Seed starter tenants and admin data
pnpm seed
```

---

## 4. Production Environment Variables Reference

| Variable | Description | Example |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string with credentials | `postgres://user:pass@host:5432/zexcore_db` |
| `NODE_ENV` | Application environment mode | `production` |
| `PORT` | Listening HTTP port | `3000` |
| `HOST` | Bind host address | `0.0.0.0` |
| `CORS_ORIGIN` | Allowed web origins (comma-separated) | `https://zexcore.com.ng,https://zexcore-5d6c0.web.app` |
| `GOOGLE_CLIENT_ID` | Google OAuth web client; add the site origin under Authorized JavaScript origins. Empty hides the button | `123-abc.apps.googleusercontent.com` |
| `RESEND_API_KEY` / `EMAIL_FROM` | Sends password-reset and email-confirmation emails (Resend; verify your sending domain first). Without them sign-up still works, but those emails cannot be delivered | `re_...` / `ZexCore <no-reply@zexcore.com.ng>` |
| `PAYSTACK_PUBLIC_KEY` | Public key for Paystack checkout in the browser | `pk_live_...` |
| `PUBLIC_APP_URL` | Origin used in payment links sent to customers | `https://zexcore.com.ng` |
| `TENANT_BASE_DOMAIN` | Optional wildcard-subdomain routing | `zexcore.me` |

Firebase Hosting serves `apps/dashboard/dist` with a strict Content-Security-Policy (see `firebase.json`). If your API runs on a host other than `https://zexcore-api.onrender.com`, change it in `connect-src` before deploying, and set `VITE_API_URL` when building the dashboard.
| `JWT_SECRET` | Cryptographic key for signing tenant tokens | `min-32-chars-crypto-random-secret` |
| `SESSION_TTL_HOURS` | Expiration for auth sessions | `24` |
| `LOG_LEVEL` | Pino logging level | `info` |
