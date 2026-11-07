# Platform admins

A platform admin can give any workspace a plan without payment (for you and your co-founder to unlock everything, or to set up Enterprise and Dedicated customers). It does **not** give access to any business's data, and every grant is written to that workspace's tamper-evident audit log with who did it.

## Set the list (once, and whenever it changes)
```
cd workers/payments
npx wrangler secret put PLATFORM_ADMIN_EMAILS     # paste: one@example.com,two@example.com  then Enter
npx wrangler deploy
```
The address must be the one you sign in with, and Firebase must have verified it (Google sign-in is). An empty list means nobody.

## Use it
Sign in, open **Plan & billing**, scroll to **Platform admin**. The workspace ID defaults to the one you are in. Choose a plan, leave Days empty for no expiry, and press Grant plan. Paid plans can be granted; to put a workspace back on Free, delete its `plan` field or set it to `free` in the Firestore console.

Grants stamp `planGrantedBy` and `planGrantedAt` on the workspace, so comped plans are easy to find.
