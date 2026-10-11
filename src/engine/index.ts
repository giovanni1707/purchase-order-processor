import { buildCalc, injectCached } from './calc';
import { FillOptions, FillResult, fillWorkbook } from './fill';
import { sharedStrings } from './ooxml';

export * from './fill';
export * from './ooxml';
export { verifyWorkbook } from './verify';
export { inspectWorkbook } from './inspect';
export type { WorkbookInspection } from './inspect';
export type { CheckResult, VerifyInput } from './verify';

/** Fill the workbook and store HyperFormula results as cached values in the two edited sheets. */
export function buildPurchaseOrder(template: ArrayBuffer | Uint8Array, opts: FillOptions): Promise<FillResult> {
  return fillWorkbook(template, opts, ({ pkg, orderRoot, poRoot, orderName, poName }) => {
    const sst = sharedStrings(pkg);
    const sheets = [
      { name: orderName, root: orderRoot },
      { name: poName, root: poRoot },
    ];
    const calc = buildCalc(sheets, sst);
    for (const sh of sheets) injectCached(sh, calc);
  });
}
