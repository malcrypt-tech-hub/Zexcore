# Email delivery

ZexCore's Worker owns outbound email delivery. Application code sends messages through the provider contract in `src/email-provider.ts`; the current adapter is Resend. Existing callers can continue using the boolean `sendMail` helper in `src/mail.ts`.

## Configuration

Set these in the Cloudflare Worker environment, not in source control:

- `RESEND_API_KEY` — Resend API key.
- `MAIL_FROM` — verified sender identity, for example `ZexCore <notifications@your-verified-domain.example>`.

Verify the sending domain with Resend and publish the DNS records it supplies (typically SPF and DKIM; configure DMARC for your domain policy). Keep API keys in Worker secrets and rotate them if exposed.

## Design and safety

- The provider adapter returns a typed result including whether a failure is retryable.
- The existing boolean helper remains for backwards compatibility.
- Provider credentials are platform secrets; never accept them from a public request or store them in tenant-editable settings.
- Tenant-specific sender domains and bring-your-own-provider credentials require a separate verified-domain and encrypted-secret-management flow. They are intentionally not enabled by this first slice.
- Delivery acceptance is not proof of inbox delivery. A later delivery-event layer should track provider webhooks and bounces.

## Current scope

This is the first email-infrastructure slice, not the complete notification product. Templates, event-triggered confirmations/receipts/reminders, tenant preferences, unsubscribe handling for non-transactional mail, retry queues and delivery analytics remain follow-on work.
