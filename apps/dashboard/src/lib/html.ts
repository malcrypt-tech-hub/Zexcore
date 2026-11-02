/** Tiny XSS-safe templating: interpolated values are HTML-escaped unless wrapped with raw()/html``. */
export class Raw {
  readonly value: string;
  constructor(value: string) { this.value = value; }
  toString(): string { return this.value; }
}
export const raw = (s: string): Raw => new Raw(s);

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };
export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]!);
}

function render(v: unknown): string {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (v instanceof Raw) return v.value;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) {
      const v = values[i];
      // aria-checked="${cond}" must read "true" / "false"; a bare boolean otherwise renders nothing (used for conditional blocks)
      out += typeof v === 'boolean' && /\baria-[a-z]+="$/.test(s) ? String(v) : render(v);
    }
  });
  return new Raw(out);
}

export function mount(el: Element, content: Raw | string): void {
  el.innerHTML = content instanceof Raw ? content.value : esc(content);
}

export function $(sel: string, root: ParentNode = document): HTMLElement | null {
  return root.querySelector<HTMLElement>(sel);
}
export function $$(sel: string, root: ParentNode = document): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(sel));
}
