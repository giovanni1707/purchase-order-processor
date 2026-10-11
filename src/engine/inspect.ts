import { ORDER_SHEET, PO_SHEET, findRowByText } from './fill';
import { Package, cellMap, cellText, findSheet, parseXml, rowMap, sharedStrings } from './ooxml';

export interface WorkbookInspection {
  ok: boolean;
  error?: string;
  /** current text of the first PO "Details" cell (the template ships sample text there) */
  details: string | null;
}

/** Cheap check done when the workbook is chosen: right sheets present? what is in the first Details cell? */
export async function inspectWorkbook(buf: ArrayBuffer | Uint8Array): Promise<WorkbookInspection> {
  try {
    const pkg = await Package.load(buf);
    findSheet(pkg, ORDER_SHEET);
    const po = findSheet(pkg, PO_SHEET);
    const root = parseXml(pkg.get(po.part)).documentElement;
    const sst = sharedStrings(pkg);
    const hdr = findRowByText(root, sst, 'A', (t) => t.trim().toLowerCase() === 'pos', 1, 60);
    if (hdr === null) return { ok: true, details: null };
    const row = rowMap(root).get(hdr + 1);
    const cell = row ? cellMap(row)['E'] : undefined;
    const text = cell ? cellText(cell, sst) : null;
    return { ok: true, details: text && text.trim() ? text : null };
  } catch {
    return {
      ok: false,
      error: "This is not the Template_Purchase_Order workbook (sheets 'Order list' and 'PO Multivac' are required).",
      details: null,
    };
  }
}
