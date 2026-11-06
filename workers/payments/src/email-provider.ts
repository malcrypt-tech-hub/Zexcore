import type { Deps, Env } from './env';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from?: string;
  replyTo?: string;
  /** Same key, same email: the provider drops a repeat sent within about a day, so a retry after a crash cannot double-send. */
  idempotencyKey?: string;
}

export type EmailSendResult =
  | { ok: true; provider: 'resend'; messageId?: string }
  | { ok: false; provider: 'resend' | 'none'; reason: 'not_configured' | 'invalid_message' | 'provider_rejected' | 'network_error'; retryable: boolean };

export interface EmailProvider {
  readonly name: 'resend';
  send(message: EmailMessage): Promise<EmailSendResult>;
}

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** Platform Resend adapter. Provider credentials stay in Worker secrets, never tenant-controlled request data. */
export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend' as const;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetcher: typeof fetch,
    private readonly defaultFrom: string,
    private readonly defaultReplyTo: string,
  ) {}

  async send(message: EmailMessage): Promise<EmailSendResult> {
    if (!this.apiKey) return { ok: false, provider: 'none', reason: 'not_configured', retryable: false };
    const to = message.to.trim();
    const subject = message.subject.trim();
    if (!EMAIL_RE.test(to) || !subject || subject.length > 200 || !message.text || message.text.length > 20_000 || (message.html?.length ?? 0) > 100_000) {
      return { ok: false, provider: 'resend', reason: 'invalid_message', retryable: false };
    }

    try {
      const response = await this.fetcher('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', ...(message.idempotencyKey ? { 'idempotency-key': message.idempotencyKey } : {}) },
        body: JSON.stringify({
          from: message.from || this.defaultFrom,
          to: [to],
          reply_to: message.replyTo || this.defaultReplyTo,
          subject,
          text: message.text,
          ...(message.html ? { html: message.html } : {}),
        }),
      });
      if (!response.ok) {
        // Do not expose provider response bodies: they can contain recipient or account details.
        return { ok: false, provider: 'resend', reason: 'provider_rejected', retryable: response.status === 429 || response.status === 409 || response.status >= 500 };
      }
      let messageId: string | undefined;
      try {
        const payload = await response.json() as { id?: unknown };
        if (typeof payload.id === 'string') messageId = payload.id;
      } catch { /* Some compatible gateways return an empty success response. */ }
      return { ok: true, provider: 'resend', ...(messageId ? { messageId } : {}) };
    } catch {
      return { ok: false, provider: 'resend', reason: 'network_error', retryable: true };
    }
  }
}

export function createEmailProvider(env: Env, d: Deps): EmailProvider {
  return new ResendEmailProvider(
    env.RESEND_API_KEY,
    d.fetch,
    env.MAIL_FROM || 'ZexCore <notifications@zexcore.com.ng>',
    'hello@zexcore.com.ng',
  );
}
