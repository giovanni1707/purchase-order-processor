import { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, FileText, Loader2, XCircle } from 'lucide-react';
import { buildPurchaseOrder, inspectWorkbook, verifyWorkbook } from './engine';
import type { CheckResult, DetailsMode, QuoteItem, WorkbookInspection } from './engine';
import type { QuotationExtraction } from './services/geminiExtractor';

type Phase = 'idle' | 'running' | 'done' | 'uncertain' | 'error';
type DetailsChoice = 'keep' | 'clear' | 'replace';

interface Result {
  items: QuoteItem[];
  extraction: QuotationExtraction;
  rate: number;
  total: number;
  checks: CheckResult[];
  bytes: Uint8Array;
  fileName: string;
  notices: string[];
}

const RATE_RE = /^\d+(\.\d+)?$/;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const readBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('Could not read the PDF file.'));
    r.readAsDataURL(file);
  });

function DropZone(props: {
  label: string;
  hint: string;
  accept: string;
  file: File | null;
  icon: 'pdf' | 'xlsx';
  onFile: (f: File | null) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const Icon = props.icon === 'pdf' ? FileText : FileSpreadsheet;
  return (
    <div
      onClick={() => ref.current?.click()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files?.[0];
        if (f) props.onFile(f);
      }}
      className={`flex cursor-pointer items-center gap-3 rounded-xl border-2 border-dashed px-4 py-3 transition ${
        over ? 'border-slate-500 bg-slate-100' : props.file ? 'border-emerald-300 bg-emerald-50' : 'border-slate-300 hover:border-slate-400'
      }`}
    >
      <Icon className={`h-6 w-6 shrink-0 ${props.file ? 'text-emerald-600' : 'text-slate-400'}`} />
      <div className="min-w-0">
        <div className="text-sm font-medium text-slate-800">{props.label}</div>
        <div className="truncate text-xs text-slate-500">{props.file ? props.file.name : props.hint}</div>
      </div>
      <input
        ref={ref}
        type="file"
        accept={props.accept}
        className="hidden"
        onChange={(e) => {
          props.onFile(e.target.files?.[0] || null);
          e.target.value = '';
        }}
      />
    </div>
  );
}

export default function App() {
  const [pdf, setPdf] = useState<File | null>(null);
  const [xlsx, setXlsx] = useState<File | null>(null);
  const [inspection, setInspection] = useState<WorkbookInspection | null>(null);
  const [rate, setRate] = useState('');
  const [detailsChoice, setDetailsChoice] = useState<DetailsChoice>('clear');
  const [detailsText, setDetailsText] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [uncertainties, setUncertainties] = useState<string[]>([]);
  const [result, setResult] = useState<Result | null>(null);

  const rateOk = RATE_RE.test(rate.trim()) && Number(rate) > 0;
  const rateError = rate.trim() !== '' && !rateOk ? 'Enter one plain number, e.g. 54.99' : '';
  const replaceMissing = inspection?.details && detailsChoice === 'replace' && !detailsText.trim();
  const canRun = !!pdf && !!xlsx && inspection?.ok === true && rateOk && !replaceMissing && phase !== 'running';

  async function chooseWorkbook(f: File | null) {
    setXlsx(f);
    setInspection(null);
    setDetailsChoice('clear');
    setDetailsText('');
    if (f) setInspection(await inspectWorkbook(await f.arrayBuffer()));
  }

  function reset() {
    setPhase('idle');
    setResult(null);
    setError('');
    setUncertainties([]);
    setProgress('');
  }

  async function run() {
    if (!pdf || !xlsx) return;
    setPhase('running');
    setError('');
    try {
      setProgress('Reading quotation…');
      const pdfBase64 = await readBase64(pdf);
      setProgress('Running verification passes…');
      const resp = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfBase64 }),
      });
      let data: any;
      try {
        data = await resp.json();
      } catch {
        throw new Error(resp.status === 413 ? 'The PDF is too large to send.' : `The server returned an unreadable answer (HTTP ${resp.status}).`);
      }
      if (!resp.ok && !data?.error && !data?.uncertainties) throw new Error(`Extraction failed (HTTP ${resp.status}).`);
      if (data.error) throw new Error(data.error);
      if (!data.success || !data.extraction) {
        setUncertainties(data.uncertainties?.length ? data.uncertainties : [data.message || 'The quotation could not be read reliably.']);
        setPhase('uncertain');
        return;
      }
      const extraction: QuotationExtraction = data.extraction;
      const items: QuoteItem[] = extraction.positions.map((p) => ({
        reference: String(p.reference).trim(),
        description: String(p.partName).trim(),
        netPrice: p.netPrice,
        quantity: p.quantity,
        unit: p.unit,
      }));
      const numericRate = Number(rate.trim());
      const mode: DetailsMode = inspection?.details && detailsChoice === 'keep' ? 'keep' : 'clear';
      if (inspection?.details && detailsChoice === 'replace') items[0].details = detailsText.trim();
      const opts = { items, rate: numericRate, quotationNo: String(extraction.quotationNumber).trim(), detailsMode: mode };

      setProgress('Filling workbook…');
      const template = new Uint8Array(await xlsx.arrayBuffer());
      const built = await buildPurchaseOrder(template, opts);

      setProgress('Verifying…');
      const checks = await verifyWorkbook({
        original: template,
        output: built.bytes,
        opts,
        invoiceAmount: extraction.invoiceAmount,
        lineAmounts: extraction.positions.map((p) => p.lineAmount),
        listPrices: extraction.positions.map((p) => p.listPrice),
      });

      const notices: string[] = [];
      const odd = extraction.positions.filter((p) => String(p.unit).toUpperCase() !== 'PC');
      if (odd.length) notices.push(`Non-PC units: ${odd.map((p) => `Pos ${p.position} (${p.quantity} ${p.unit})`).join(', ')}. Quantity is entered as printed.`);
      if (extraction.ignoredLines?.length) notices.push(`Ignored lines: ${extraction.ignoredLines.map((l) => l.lineText).join('; ')}`);
      notices.push('Order list columns A, B, E, F, I now hold typed values instead of links to Quotation_Multivac.');
      notices.push('The PO number and date at the top of PO Multivac come from the Template sheet and still show placeholders until you fill Template.');
      notices.push('Footer dates on PO Multivac and the rate-header date in Order list are fixed text and were left unchanged.');
      if (inspection?.details) {
        notices.push(detailsChoice === 'keep' ? 'PO Details text: kept as in the template.' : detailsChoice === 'clear' ? 'PO Details text: cleared.' : 'PO Details text: replaced with your text.');
      }
      if (items.length > 12) notices.push("With many items the PO's closing frame can flow onto a second printed page.");
      notices.push('Excel will recalculate when the file opens and may ask about updating external links.');
      notices.push('Existing errors in other sheets were left as they were.');

      setResult({
        items,
        extraction,
        rate: numericRate,
        total: Math.round(items.reduce((s, i) => s + i.netPrice * i.quantity, 0) * 100) / 100,
        checks,
        bytes: built.bytes,
        fileName: `${xlsx.name.replace(/\.xlsx$/i, '')}_filled.xlsx`,
        notices,
      });
      setPhase('done');
    } catch (e: any) {
      setError(e?.message || String(e));
      setPhase('error');
    }
  }

  function download() {
    if (!result) return;
    const blob = new Blob([result.bytes as BlobPart], { type: XLSX_MIME });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = result.fileName;
    a.click();
    URL.revokeObjectURL(url);
  }

  const failed = result?.checks.filter((c) => !c.ok) || [];
  const allPass = !!result && failed.length === 0;

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10 text-slate-900">
      <div className="mx-auto w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold">MULTIVAC Purchase Order</h1>
        <p className="mt-1 text-sm text-slate-500">Fills the Order list and PO Multivac sheets from a quotation PDF.</p>

        {(phase === 'idle' || phase === 'running' || phase === 'error') && (
          <div className="mt-6 space-y-4">
            <DropZone label="Quotation PDF" hint="Drop or click to choose" accept="application/pdf,.pdf" file={pdf} icon="pdf" onFile={setPdf} />
            <DropZone label="Template_Purchase_Order_2026.xlsx" hint="Drop or click to choose" accept=".xlsx" file={xlsx} icon="xlsx" onFile={chooseWorkbook} />
            {inspection && !inspection.ok && <p className="text-sm text-red-600">{inspection.error}</p>}

            <div>
              <label className="text-sm font-medium text-slate-800" htmlFor="rate">
                Exchange rate (1 EUR = ? MUR)
              </label>
              <input
                id="rate"
                inputMode="decimal"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="e.g. 54.99"
                className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
              />
              {rateError && <p className="mt-1 text-xs text-red-600">{rateError}</p>}
            </div>

            {inspection?.ok && inspection.details && (
              <div>
                <div className="text-sm font-medium text-slate-800">PO Details text</div>
                <p className="text-xs text-slate-500">The template holds “{inspection.details}” in the first Details cell.</p>
                <div className="mt-2 flex gap-4 text-sm">
                  {(['keep', 'clear', 'replace'] as const).map((c) => (
                    <label key={c} className="flex items-center gap-1.5">
                      <input type="radio" name="details" checked={detailsChoice === c} onChange={() => setDetailsChoice(c)} />
                      {c === 'keep' ? 'Keep' : c === 'clear' ? 'Clear' : 'Replace with my text'}
                    </label>
                  ))}
                </div>
                {detailsChoice === 'replace' && (
                  <input
                    value={detailsText}
                    onChange={(e) => setDetailsText(e.target.value)}
                    placeholder="Details text"
                    className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
                  />
                )}
              </div>
            )}

            {phase === 'error' && (
              <div className="flex items-start gap-2 rounded-lg bg-red-50 p-3 text-sm text-red-700">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button
              onClick={run}
              disabled={!canRun}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition enabled:hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {phase === 'running' ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {progress}
                </>
              ) : (
                'Generate purchase order'
              )}
            </button>
          </div>
        )}

        {phase === 'uncertain' && (
          <div className="mt-6 space-y-3">
            <div className="flex items-center gap-2 text-amber-700">
              <AlertTriangle className="h-5 w-5" />
              <span className="font-medium">Uncertain values detected</span>
            </div>
            <p className="text-sm text-slate-600">No file was generated because the quotation could not be read with certainty:</p>
            <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
              {uncertainties.map((u, i) => (
                <li key={i}>{u}</li>
              ))}
            </ul>
            <button onClick={reset} className="text-sm text-slate-500 underline">
              Start over
            </button>
          </div>
        )}

        {phase === 'done' && result && (
          <div className="mt-6 space-y-4">
            <div className={`flex items-center gap-2 rounded-lg p-3 text-sm font-medium ${allPass ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
              {allPass ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
              {allPass ? `All checks passed (${result.checks.length} of ${result.checks.length})` : `${failed.length} of ${result.checks.length} checks failed. No download offered.`}
            </div>
            {!allPass && (
              <ul className="list-disc space-y-1 pl-5 text-sm text-red-700">
                {failed.map((c, i) => (
                  <li key={i}>
                    {c.name}
                    {c.detail ? `: ${c.detail}` : ''}
                  </li>
                ))}
              </ul>
            )}

            <p className="text-xs text-slate-600">
              Rate {result.rate} · Order list {result.items.length} rows · PO {result.items.length} rows · Total Exworks {result.total.toFixed(2)} vs Invoice amount{' '}
              {result.extraction.invoiceAmount.toFixed(2)} · PO total {result.total.toFixed(2)} · Quotation {result.extraction.quotationNumber}
            </p>

            <div className="max-h-64 overflow-auto rounded-lg border border-slate-200">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-slate-100 text-slate-600">
                  <tr>
                    <th className="px-3 py-2">Reference</th>
                    <th className="px-3 py-2">Part Name</th>
                    <th className="px-3 py-2 text-right">Net Price</th>
                    <th className="px-3 py-2 text-right">Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((it, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="px-3 py-1.5 font-mono">{it.reference}</td>
                      <td className="px-3 py-1.5">{it.description}</td>
                      <td className="px-3 py-1.5 text-right">{it.netPrice.toFixed(2)}</td>
                      <td className="px-3 py-1.5 text-right">
                        {it.quantity}
                        {it.unit && it.unit.toUpperCase() !== 'PC' ? ` ${it.unit}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="rounded-lg bg-slate-50 p-3">
              <div className="text-xs font-medium text-slate-700">Notices</div>
              <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-slate-600">
                {result.notices.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            </div>

            <div className="flex items-center justify-between">
              <button
                onClick={download}
                disabled={!allPass}
                className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition enabled:hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Download className="h-4 w-4" />
                Download filled workbook
              </button>
              <button onClick={reset} className="text-sm text-slate-500 underline">
                Start over
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
