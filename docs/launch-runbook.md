# Launch runbook (Firebase + Cloudflare Worker)

Steps marked **you** need a dashboard login. Everything else is automated by CI on merge to `main`.

## 1. Firebase (you)
1. Authentication → Sign-in method: enable **Email/Password** and **Google**. Authentication → Settings → Authorized domains: add `zexcore.com.ng`.
2. Firestore database exists in project `zexcore-5d6c0`. Rules and indexes deploy from this repo.
3. Optional but recommended: **App Check** (reCAPTCHA) so bots cannot use up a business's monthly booking allowance on the public page.

## 2. GitHub (you)
Secrets: `FIREBASE_SERVICE_ACCOUNT` (Firebase Hosting Admin + rules deploy), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.
Variable: `VITE_PAYMENTS_URL` = the Worker URL (`https://zexcore-payments.<subdomain>.workers.dev`). After setting it, re-run "Deploy dashboard to Firebase Hosting".
Branch protection on `main`: require the CI checks, no force pushes.

## 3. Cloudflare Worker secrets (you)
Workers & Pages → `zexcore-payments` → Settings → Variables and Secrets:
- `PAYSTACK_SECRET_KEY` (live key)
- `FIREBASE_SERVICE_ACCOUNT`: a **new** service account JSON with only *Cloud Datastore User*
- optional `RESEND_API_KEY` and `MAIL_FROM` (an address on a Resend-verified domain) for e-mail alerts
- optional `DEPOSIT_FEE_MINOR`: flat fee in kobo kept per deposit
Optional: automation "draft with AI" uses the customer's own Gemini or OpenAI key, entered in the browser. No Worker setup is needed.

## 4. Paystack (you)
Settings → API Keys & Webhooks → webhook URL `https://<worker-url>/api/paystack-webhook`. It carries both plan payments and customer deposits.

## 5. Data expiry (you, once)
Device readings, alerts and automation runs carry an `expireAt` field. Turn on Firestore TTL so old rows are removed:
```
gcloud firestore fields ttls update expireAt --collection-group=readings --enable-ttl --project=zexcore-5d6c0
gcloud firestore fields ttls update expireAt --collection-group=alerts --enable-ttl --project=zexcore-5d6c0
gcloud firestore fields ttls update expireAt --collection-group=automationRuns --enable-ttl --project=zexcore-5d6c0
```

## 6. Smoke test before announcing
1. `GET <worker-url>/api/health` returns `{"status":"ok"}`.
2. Sign up with e-mail, verify the address, sign out, sign in. Repeat with Google.
3. Add a service and staff member, open `zexcore.com.ng/<your-slug>`, make a booking; it appears in Bookings and the owner gets a notification.
4. Settings: add a bank account (name must resolve), set a deposit, turn deposits on. Book on the public page, pay with a Paystack test card, confirm the booking turns confirmed and shows "paid".
5. Upgrade a plan with a Paystack test payment; the plan changes within seconds.
6. Devices: register a device, post a reading with the shown token, trigger an alert.
7. Audit log page: "Verify integrity" reports the chain intact.
8. Rotate any token that was ever pasted into chat or logs.

## Known limits
- The inbox sends through WhatsApp links (`wa.me`); there is no inbound WhatsApp integration.
- Automations are event-driven (booking created, lead created, device reading/alert); there is no time-based scheduling yet.
- No rate limiting beyond Firestore rules and one reading per second per device; add Cloudflare rate-limit rules on the Worker route if abuse appears.
