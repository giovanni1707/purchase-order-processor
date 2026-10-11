// Node test: npm run test:engine -- [items.json] [template.xlsx]
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
(globalThis as any).DOMParser = DOMParser;
(globalThis as any).XMLSerializer = XMLSerializer;
import fs from 'node:fs';
const { buildPurchaseOrder, verifyWorkbook } = await import('../src/engine/index');
const raw = JSON.parse(fs.readFileSync(process.argv[2] || '/home/claude/items.json', 'utf8'));
const items = raw.map((o: any) => ({ reference: o.reference, description: o.description, netPrice: o.net_price, quantity: o.quantity, unit: o.unit }));
const tpl = new Uint8Array(fs.readFileSync(process.argv[3] || '/mnt/user-data/uploads/Template_Purchase_Order_2026.xlsx'));

async function run(label: string, detailsMode: 'keep' | 'clear', replaceText?: string, verifyRate?: number) {
  const its = items.map((i: any, idx: number) => ({ ...i, details: idx === 0 ? replaceText : undefined }));
  const opts = { items: its, rate: 54.99, quotationNo: '21400572', detailsMode };
  const res = await buildPurchaseOrder(tpl, opts);
  fs.writeFileSync(`/tmp/ts_out_${label}.xlsx`, res.bytes);
  const checks = await verifyWorkbook({
    original: tpl, output: res.bytes, opts: { ...opts, rate: verifyRate ?? opts.rate }, invoiceAmount: 475.37,
    lineAmounts: raw.map((o: any) => o.line_amount), listPrices: raw.map((o: any) => o.list_price),
  });
  const failed = checks.filter((c) => !c.ok);
  console.log(`${label}: ${checks.length - failed.length}/${checks.length} checks passed`);
  for (const f of failed.slice(0, 4)) console.log('   FAIL', f.name, '->', f.detail);
}
await run('clear', 'clear');
await run('keep', 'keep');
await run('replace', 'clear', 'Spare parts for line 3');
await run('tampered(expect failures)', 'clear', undefined, 54.98);
