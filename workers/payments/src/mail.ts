import type { Deps, Env } from './env';

const escHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const REPLY_TO = 'hello@zexcore.com.ng';

export interface EmailSpec {
  /** Big heading at the top of the card. */
  heading: string;
  /** "Hello Ada," style opening line. Omit for none. */
  greeting?: string;
  paragraphs: string[];
  /** A small table of facts (label, value). */
  details?: [string, string][];
  /** Text on the button; the address sits behind it so the message stays tidy. */
  button?: { text: string; url: string };
  /** Short grey note under the button. */
  note?: string;
  /** Hidden preview line shown by mail apps beside the subject. */
  preheader?: string;
  /** Branded card layout. Only for payment invoices and receipts; every other message is plain, formal text. */
  card?: boolean;
}

/** Plain text and HTML versions of one formal, branded message. Everything interpolated is escaped. */
export function renderEmail(spec: EmailSpec, appUrl: string): { text: string; html: string } {
  const e = escHtml;
  const text = [
    spec.greeting ?? '', ...spec.paragraphs,
    ...(spec.details ? ['', ...spec.details.map(([k, v]) => `${k}: ${v}`)] : []),
    ...(spec.button ? ['', `${spec.button.text}: ${spec.button.url}`] : []),
    ...(spec.note ? ['', spec.note] : []),
    '', 'ZexCore by Zexlabs', `${appUrl}`, `Questions? Reply to this email or write to ${REPLY_TO}.`,
  ].filter((l, i, a) => !(l === '' && (i === 0 || a[i - 1] === ''))).join('\n');
  const rows = spec.details ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:20px 0;border:1px solid #e5e7eb;border-radius:10px;border-collapse:separate;overflow:hidden">${
    spec.details.map(([k, v], i) => `<tr><td style="padding:11px 16px;font-size:13px;color:#6b7280;width:38%;${i ? 'border-top:1px solid #e5e7eb;' : ''}background:#f9fafb">${e(k)}</td><td style="padding:11px 16px;font-size:14px;color:#111827;font-weight:600;${i ? 'border-top:1px solid #e5e7eb;' : ''}">${e(v)}</td></tr>`).join('')}</table>` : '';
  const button = spec.button ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0 8px"><tr><td style="background:#c8102e;border-radius:8px"><a href="${e(spec.button.url)}" style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none">${e(spec.button.text)}</a></td></tr></table>` : '';
  if (!spec.card) {
    const p = (t: string): string => `<p style="margin:0 0 14px">${e(t)}</p>`;
    const facts = spec.details ? `<p style="margin:0 0 14px">${spec.details.map(([k, v]) => `${e(k)}: ${e(v)}`).join('<br>')}</p>` : '';
    const link = spec.button ? `<p style="margin:0 0 14px">${e(spec.button.text)}: <a href="${e(spec.button.url)}">${e(spec.button.url)}</a></p>` : '';
    const plain = `<!doctype html><html><body style="margin:0;padding:16px;background:#ffffff;color:#111111;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6">
${spec.greeting ? p(spec.greeting) : ''}${spec.paragraphs.map(p).join('')}${facts}${link}${spec.note ? p(spec.note) : ''}<p style="margin:0 0 14px">Kind regards,<br>The ZexCore team<br>ZexCore, a product of Zexlabs<br><a href="${e(appUrl)}">${e(appUrl)}</a></p>
<p style="margin:18px 0 0;font-size:12px;color:#666666">Questions? Reply to this email or write to <a href="mailto:${REPLY_TO}">${REPLY_TO}</a>.</p></body></html>`;
    return { text: text.replace('\nZexCore by Zexlabs\n', '\nKind regards,\nThe ZexCore team\nZexCore, a product of Zexlabs\n'), html: plain };
  }
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${e(spec.preheader ?? spec.heading)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb">
<tr><td style="background:#c8102e;padding:20px 28px"><span style="font-size:20px;font-weight:800;color:#ffffff;letter-spacing:-0.3px">ZexCore</span></td></tr>
<tr><td style="padding:32px 28px 8px">
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;color:#111827">${e(spec.heading)}</h1>
${spec.greeting ? `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#374151">${e(spec.greeting)}</p>` : ''}
${spec.paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#374151">${e(p)}</p>`).join('')}
${rows}${button}
${spec.note ? `<p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#6b7280">${e(spec.note)}</p>` : ''}
</td></tr>
<tr><td style="padding:24px 28px 28px"><hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 16px">
<p style="margin:0;font-size:12px;line-height:1.6;color:#9ca3af">Sent by ZexCore, a product of Zexlabs. Questions? Reply to this email or write to <a href="mailto:${REPLY_TO}" style="color:#6b7280">${REPLY_TO}</a>.</p>
</td></tr></table></td></tr></table></body></html>`;
  return { text, html };
}

/** Sends a plain-text (and optionally HTML) e-mail through Resend when it is configured; otherwise reports that nothing was sent. */
export async function sendMail(env: Env, d: Deps, to: string, subject: string, text: string, html?: string): Promise<boolean> {
  if (!env.RESEND_API_KEY || !to) return false;
  try {
    const r = await d.fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: env.MAIL_FROM || 'ZexCore <notifications@zexcore.com.ng>', to: [to], reply_to: REPLY_TO, subject: subject.slice(0, 200), text: text.slice(0, 20_000), ...(html ? { html: html.slice(0, 100_000) } : {}) }),
    });
    return r.ok;
  } catch { return false; }
}

/** The usual way to send: a formal, branded message built from a spec. */
export async function sendFormal(env: Env, d: Deps, to: string, subject: string, spec: EmailSpec): Promise<boolean> {
  const { text, html } = renderEmail(spec, env.APP_URL.replace(/\/$/, ''));
  return sendMail(env, d, to, subject, text, html);
}
