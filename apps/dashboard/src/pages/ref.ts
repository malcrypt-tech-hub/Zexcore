/** Small builders shared by the reference-structured marketing pages. Uses the existing site shell + theme tokens. */
import { renderNavbar } from '../components/navbar';
import { renderFooter } from '../components/footer';

export const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const CSS = `<style>
.rp-grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr))}
.rp-card{border:1px solid var(--border-default,#e5e7eb);border-radius:14px;padding:22px;background:#fff;min-width:0;transition:transform .18s ease,box-shadow .18s ease;cursor:default}
.rp-card:hover{transform:translateY(-3px);box-shadow:0 12px 32px rgba(0,0,0,0.08);border-color:rgba(229,9,32,.18)}
.rp-card h3{margin:0 0 8px;font-size:1.05rem;color:#0f172a}
.rp-card p{margin:0;color:#475569;line-height:1.6;font-size:.95rem}
.rp-tag{display:inline-flex;align-items:center;gap:5px;font:700 .68rem/1 'JetBrains Mono',monospace;color:#C90019;background:#FDF2F2;border:1px solid rgba(229,9,32,.25);border-radius:999px;padding:5px 10px;margin-bottom:12px;letter-spacing:.04em}
.rp-code{background:#0f172a;color:#e2e8f0;border-radius:14px;padding:18px;overflow:auto;font:.82rem/1.65 'JetBrains Mono',monospace;margin:0}
.rp-code b{color:#FCA5A5;font-weight:600}
.rp-table{width:100%;min-width:520px;border-collapse:collapse;font-size:.92rem}
.rp-table th,.rp-table td{border-bottom:1px solid #f1e3e5;padding:12px 10px;text-align:left;vertical-align:top}
.rp-table th{font-size:.75rem;letter-spacing:.06em;text-transform:uppercase;color:#C90019}
.rp-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.rp-steps{counter-reset:s;display:grid;gap:12px;padding:0;list-style:none;margin:0}
.rp-steps li{counter-increment:s;display:flex;gap:14px;align-items:flex-start;border:1px solid #f1e3e5;border-radius:12px;padding:16px;background:#fff;transition:transform .18s ease,box-shadow .18s ease}
.rp-steps li:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,0.06)}
.rp-steps li:before{content:counter(s);flex:none;width:28px;height:28px;border-radius:50%;background:#E50920;color:#fff;font-weight:700;display:grid;place-items:center;font-size:.85rem}
.rp-steps strong{display:block;color:#0f172a;margin-bottom:2px}
.rp-steps span{color:#475569;font-size:.93rem;line-height:1.55}
.rp-split{display:grid;gap:28px;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));align-items:start}
.rp-note{border-left:3px solid #E50920;background:#FDF2F2;border-radius:0 10px 10px 0;padding:14px 16px;color:#475569;font-size:.92rem;line-height:1.6;margin-top:18px}
.rp-h{margin:0 0 10px;font-size:1.8rem;letter-spacing:-.02em;color:#0f172a}
.rp-lead{margin:0 0 28px;color:#475569;max-width:720px;line-height:1.65}
.page-intro-header.page-hero-content-col{margin:0;max-width:820px}
.rp-hero{padding:88px 0 72px;background:linear-gradient(180deg,#fff,#FDF2F2);border-bottom:1px solid #f1e3e5}
.rp-hero-copy{max-width:800px;margin:0 auto;text-align:center}
.rp-hero-title{font-size:clamp(2.2rem,6vw,3.6rem);line-height:1.08;letter-spacing:-.035em;margin:0 0 18px;color:#0f172a}
.rp-hero-red{color:#E50920}
.rp-hero-desc{font-size:1.1rem;line-height:1.65;color:#475569;margin:0 auto 28px;max-width:640px}
.rp-hero-actions{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.rp-hero-strip{display:flex;gap:10px 0;justify-content:center;flex-wrap:wrap;margin-top:28px;font-size:.86rem;color:#64748b;font-weight:500}
.rp-hero-strip-item{display:inline-flex;align-items:center;gap:6px;padding:0 18px}
.rp-hero-strip-item+.rp-hero-strip-item{border-left:1px solid #dde1e7}
.rp-hero-strip-item svg{color:#22c55e;flex-shrink:0}
.rp-code-wrap{background:#0f172a;border-radius:12px;padding:20px 24px;overflow-x:auto;margin:16px 0}
.rp-code-wrap code{color:#e2e8f0;font-family:'JetBrains Mono',monospace;font-size:.88rem;line-height:1.6}
</style>`;

export interface Cta { text: string; href: string; primary?: boolean }

export function intro(eyebrow: string, title: string, desc: string, ctas: Cta[] = []): string {
  return `<section class="section-white page-intro-section"><div class="site-container"><div class="page-intro-header">
    <div class="section-eyebrow">${esc(eyebrow)}</div><h1 class="page-intro-title">${esc(title)}</h1><p class="page-intro-desc">${esc(desc)}</p>
    ${ctas.length ? `<div class="final-cta-buttons" style="justify-content:flex-start;margin-top:22px">${ctas.map((c) => `<a href="${c.href}" data-link class="btn ${c.primary ? 'btn-primary' : 'btn-secondary'} btn-lg">${esc(c.text)}</a>`).join('')}</div>` : ''}
  </div></div></section>`;
}

export function block(title: string, lead: string, body: string, tinted = false, id = ''): string {
  return `<section ${id ? `id="${id}"` : ''} class="${tinted ? 'section-tinted-red' : 'section-white'} section-padded" style="padding:56px 0"><div class="site-container">
    <h2 class="rp-h">${esc(title)}</h2>${lead ? `<p class="rp-lead">${esc(lead)}</p>` : ''}${body}</div></section>`;
}

export function cards(items: { tag?: string; title: string; text: string }[]): string {
  return `<div class="rp-grid">${items.map((i) => `<div class="rp-card">${i.tag ? `<span class="rp-tag">${esc(i.tag)}</span>` : ''}<h3>${esc(i.title)}</h3><p>${esc(i.text)}</p></div>`).join('')}</div>`;
}

export function steps(items: { title: string; text: string }[]): string {
  return `<ol class="rp-steps">${items.map((i) => `<li><div><strong>${esc(i.title)}</strong><span>${esc(i.text)}</span></div></li>`).join('')}</ol>`;
}

export function table(head: string[], rows: string[][]): string {
  return `<div class="rp-scroll"><table class="rp-table"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

/** code is pre-escaped HTML; wrap keywords in <b>. */
export function code(html: string): string { return `<pre class="rp-code"><code>${html}</code></pre>`; }

export function cta(title: string, text: string, ctas: Cta[]): string {
  return `<section class="section-tinted-red final-cta-section"><div class="site-container final-cta-inner"><h2 class="final-cta-headline">${esc(title)}</h2>
    <p class="final-cta-subtext">${esc(text)}</p><div class="final-cta-buttons">${ctas.map((c) => `<a href="${c.href}" data-link class="btn ${c.primary ? 'btn-primary' : 'btn-secondary'} btn-lg">${esc(c.text)}</a>`).join('')}</div></div></section>`;
}

export function shell(active: string, ...sections: string[]): string {
  return `${CSS}<div class="page-wrapper">${renderNavbar(active)}<main>${sections.join('')}</main>${renderFooter()}</div>`;
}
