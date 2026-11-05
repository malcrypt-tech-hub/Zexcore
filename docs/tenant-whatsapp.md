# Tenant WhatsApp Business connections

Each workspace can connect its own WhatsApp Business Platform phone number. The connection endpoints are Worker-only; browser clients never receive access tokens.

## Cloudflare setup

Generate a dedicated 32-byte encryption key:

```sh
openssl rand -base64 32
```

Set it as a Worker secret (do not put it in `wrangler.toml` or source control):

```sh
npx wrangler secret put WHATSAPP_ENCRYPTION_KEY
```

Keep a secure backup of this key. If it is lost, encrypted workspace access tokens cannot be recovered; affected workspaces must reconnect.

## Workspace API

All requests require a Firebase ID token in `Authorization: Bearer ...` and a JSON body containing `workspaceId`. Only workspace owners and admins can manage the connection.

- `POST /api/whatsapp/status` — returns connection metadata, never credentials.
- `POST /api/whatsapp/connect` — accepts `accessToken` and `phoneNumberId`, verifies the exact phone-number resource with Meta Graph API, then encrypts and stores the token using AES-256-GCM.
- `POST /api/whatsapp/disconnect` — disables the connection and clears the encrypted token fields.

The Meta access token must have permission to read and send messages for the selected WhatsApp Business phone number. The connection is not yet used to send customer follow-ups; sequence configuration, opt-in controls, durable scheduling, delivery webhooks and approved-template handling are subsequent work.
