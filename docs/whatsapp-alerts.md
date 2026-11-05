# WhatsApp alerts to the business owner

ZexCore can send the owner a WhatsApp message for every new booking request. WhatsApp only lets a business start a chat with a **pre-approved message template**, so this needs a one-off setup by whoever runs ZexCore (not each customer business).

## One-off setup

1. In **Meta Business Manager**, create a WhatsApp Business account and add a sending phone number. Complete Meta business verification (needed for production volume).
2. In **WhatsApp Manager > Message templates**, create a template:
   - Name: `new_booking_request`
   - Category: Utility
   - Language: English
   - Body (exactly four variables, in this order):

     `New booking request at {{1}}: {{2}} would like to book {{3}} for {{4}}. Open ZexCore to confirm or decline.`

   Wait for Meta to approve it.
3. Create a permanent access token (System User, `whatsapp_business_messaging` permission).
4. In Cloudflare, on the `zexcore-payments` Worker, set:
   - Secret `WHATSAPP_TOKEN` = the access token
   - Variable `WHATSAPP_PHONE_ID` = the sending number's Phone number ID (not the phone number itself)
   - Optional: `WHATSAPP_TEMPLATE_BOOKING` (default `new_booking_request`) and `WHATSAPP_TEMPLATE_LANG` (default `en`)
5. Redeploy the Worker. `GET /api/health` now reports `"whatsapp": true`, and the Settings screen stops saying WhatsApp delivery is off.

## How a business uses it

Settings > Notifications > WhatsApp alerts: switch on and enter their own number. ZexCore normalises Nigerian numbers (0803... becomes 234803...); other countries need the country code.

## Honest limits

- Meta charges per conversation, billed to your WhatsApp Business account, not by ZexCore.
- If Meta refuses a message (for example the template is not approved), the booking and the email still go through; the refusal is logged in the Worker.
- Customer replies to ZexCore's number are not read by ZexCore. This is an alert, not an inbox.
