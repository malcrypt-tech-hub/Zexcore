/** A tiny one-page PDF writer (text only, built-in Helvetica) so the Worker needs no libraries. */
export interface PdfLine { text: string; size?: number; bold?: boolean; gap?: number; color?: [number, number, number] }

const latin = (s: string): string => s.replace(/[^\x20-\x7E]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export function simplePdf(lines: PdfLine[], title: string): Uint8Array {
  let y = 790;
  const ops: string[] = [];
  for (const l of lines) {
    const size = l.size ?? 11;
    y -= (l.gap ?? 0) + size * 1.35;
    const [r, g, b] = l.color ?? [0.1, 0.1, 0.1];
    ops.push(`${r} ${g} ${b} rg BT /${l.bold ? 'F2' : 'F1'} ${size} Tf 56 ${y.toFixed(1)} Td (${latin(l.text)}) Tj ET`);
  }
  // a thin rule under the heading block and a border around the page
  ops.push('0.85 0.85 0.85 RG 0.8 w 40 40 515 762 re S');
  const stream = ops.join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    `<< /Title (${latin(title)}) /Producer (ZexCore) >>`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0) & 0xff);
}
