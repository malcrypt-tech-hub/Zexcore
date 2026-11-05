/**
 * Alerts to the business owner on WhatsApp, through Meta's WhatsApp Business Cloud API.
 * WhatsApp only lets a business start a conversation with a pre-approved TEMPLATE, so the owner-alert text lives in a template
 * that the ZexCore operator creates once in Meta Business Manager (the exact text is in docs/whatsapp-alerts.md).
 * Nothing is sent unless WHATSAPP_TOKEN and WHATSAPP_PHONE_ID are set. Failure never blocks a booking.
 */
import type { Deps, Env } from './env';

export const whatsappConfigured = (env: Env): boolean => Boolean(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID);

/** "0803 123 4567", "+234 803 123 4567" or "2348031234567" -> "2348031234567" (digits only, with country code), else null. */
export function waNumber(raw: string): string | null {
  let p = raw.replace(/[\s().-]/g, '');
  if (/^0\d{10}$/.test(p)) p = `+234${p.slice(1)}`;
  else if (/^234\d{10}$/.test(p)) p = `+${p}`;
  return /^\+\d{8,15}$/.test(p) ? p.slice(1) : null;
}

/** Sends the new-booking template. `vars` fill {{1}}..{{n}} in order. Returns whether Meta accepted it. */
export async function sendBookingAlert(env: Env, d: Deps, to: string, vars: string[]): Promise<boolean> {
  if (!whatsappConfigured(env)) return false;
  try {
    const r = await d.fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(env.WHATSAPP_PHONE_ID!)}/messages`, {
      method: 'POST', headers: { authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'template', template: { name: env.WHATSAPP_TEMPLATE_BOOKING || 'new_booking_request', language: { code: env.WHATSAPP_TEMPLATE_LANG || 'en' },
        components: [{ type: 'body', parameters: vars.map((text) => ({ type: 'text', text: text.replace(/\s+/g, ' ').slice(0, 120) })) }] } }),
    });
    if (!r.ok) console.error('whatsapp alert refused', r.status);
    return r.ok;
  } catch (e) { console.error('whatsapp alert failed', e instanceof Error ? e.message : e); return false; }
}
