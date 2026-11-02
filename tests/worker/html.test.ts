import { describe, it, expect } from 'vitest';
import { html } from '../../apps/dashboard/src/lib/html';

describe('html templating', () => {
  it('writes aria booleans as true/false so selected cards are styled', () => {
    expect(html`<b aria-checked="${true}" aria-pressed="${false}">`.value).toBe('<b aria-checked="true" aria-pressed="false">');
  });
  it('still renders nothing for conditional booleans and escapes text', () => {
    expect(html`<i>${false}${true}</i>`.value).toBe('<i></i>');
    expect(html`<i>${'<x>'}</i>`.value).toBe('<i>&lt;x&gt;</i>');
  });
});
