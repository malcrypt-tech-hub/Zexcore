# Licences and dedicated clusters

## What a licence is
`ZXL1.<payload>.<signature>`. The payload is base64url JSON: `v`, `id`, `workspaceId`, `business`, `plan`, `issuedAt`, `expiresAt`, `graceDays` (3). The signature is Ed25519 over the payload text. It states which plan a workspace holds and until when (the plan's expiry; a plan with no expiry gets a one-year licence). It is a statement of entitlement and does not enforce anything: limits are enforced by the database rules.

Only owners and admins of Enterprise or Dedicated workspaces can generate one (`POST /api/license`).

## Setting it up (once)
```
cd workers/payments
node scripts/gen-license-key.mjs | npx wrangler secret put LICENSE_PRIVATE_JWK
```
Run it once. Never paste the private key anywhere. After deploying, `GET /api/public/license-key` returns the public key. Losing or changing the private key invalidates every licence issued with it.

Optional: `npx wrangler secret put SALES_EMAIL` (or a var) with the inbox that should receive dedicated cluster requests. Without it requests are still stored under `workspaces/{wid}/clusterRequests/current`, but nobody is emailed.

## Verifying
- Offline: verify the Ed25519 signature of the second part against the public key, then compare `expiresAt` to today (plus `graceDays`).
- Online: `POST /api/public/license-verify {"license": "..."}` also confirms the workspace still holds the plan.

## Dedicated cluster requests
An owner sends size, needs, region and phone from Cluster & license. One open request per workspace. Our team gets an email (if `SALES_EMAIL` is set) and the owner gets an acknowledgement. Move the request along by changing `status` (`new`, `contacted`, `closed`) in the Firestore console; closing it lets the owner send another.
