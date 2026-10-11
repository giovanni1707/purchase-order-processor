import { GoogleGenAI, Type } from '@google/genai';

export interface PositionItem {
  position: string;
  reference: string;
  partName: string;
  netPrice: number;
  listPrice: number;
  quantity: number;
  unit: string;
  lineAmount: number;
}

export interface IgnoredLine {
  lineText: string;
  reason: string;
}

export interface UnclearLine {
  item: string;
  reason: string;
}

export interface QuotationExtraction {
  quotationNumber: string;
  invoiceAmount: number;
  currency: string;
  positions: PositionItem[];
  ignoredLines: IgnoredLine[];
  unclear: UnclearLine[];
}

export interface ExtractionResult {
  success: boolean;
  extraction?: QuotationExtraction;
  uncertainties?: string[];
  message?: string;
  error?: string;
}

const extractionSchema = {
  type: Type.OBJECT,
  properties: {
    quotationNumber: {
      type: Type.STRING,
      description: 'The Document number printed at the top of the quotation (e.g. 21400572). NOT the customer number and NOT the "Your quote request" reference. If several numbers could be the quotation number, report it in the unclear array.',
    },
    invoiceAmount: {
      type: Type.NUMBER,
      description: 'The overall Invoice amount (or Total Exworks amount) shown on the MULTIVAC quotation PDF in EUR as a float.',
    },
    currency: {
      type: Type.STRING,
      description: 'Currency code, usually EUR.',
    },
    positions: {
      type: Type.ARRAY,
      description: 'All line positions (Pos. 10, 20, 30...) across ALL pages. Join positions split across page breaks.',
      items: {
        type: Type.OBJECT,
        properties: {
          position: {
            type: Type.STRING,
            description: "Position number (e.g. '10', '20', '30').",
          },
          reference: {
            type: Type.STRING,
            description: 'The bold material / part number as a string, preserving any leading zeros.',
          },
          partName: {
            type: Type.STRING,
            description: 'Full description plus dimension line (e.g. "Tension spring D1=9"). Join description and dimensions.',
          },
          netPrice: {
            type: Type.NUMBER,
            description: 'Per-unit Net price AFTER customer discount. NOT the list price and NOT the line total amount. Convert European decimal (e.g. 3,52 -> 3.52).',
          },
          listPrice: {
            type: Type.NUMBER,
            description: 'Per-unit list price before discount as a number.',
          },
          quantity: {
            type: Type.NUMBER,
            description: 'Quantity as a number.',
          },
          unit: {
            type: Type.STRING,
            description: 'Unit of measurement (e.g. PC, m, etc.).',
          },
          lineAmount: {
            type: Type.NUMBER,
            description: 'The line total amount shown on the PDF (netPrice * quantity).',
          },
        },
        required: ['position', 'reference', 'partName', 'netPrice', 'listPrice', 'quantity', 'unit', 'lineAmount'],
      },
    },
    ignoredLines: {
      type: Type.ARRAY,
      description: 'Any sub-total, text, header, or note lines without price and quantity.',
      items: {
        type: Type.OBJECT,
        properties: {
          lineText: { type: Type.STRING },
          reason: { type: Type.STRING },
        },
        required: ['lineText', 'reason'],
      },
    },
    unclear: {
      type: Type.ARRAY,
      description: 'Any ambiguous, unreadable, or uncertain items. Never guess.',
      items: {
        type: Type.OBJECT,
        properties: {
          item: { type: Type.STRING },
          reason: { type: Type.STRING },
        },
        required: ['item', 'reason'],
      },
    },
  },
  required: ['quotationNumber', 'invoiceAmount', 'currency', 'positions', 'ignoredLines', 'unclear'],
};

async function callGeminiWithRetry(ai: GoogleGenAI, params: any, maxRetries = 3, initialDelay = 1500): Promise<any> {
  let delay = initialDelay;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err: any) {
      const errStr = String(err?.message || err);
      const isTransient =
        err?.status === 429 ||
        err?.status === 503 ||
        errStr.includes('429') ||
        errStr.includes('503') ||
        errStr.includes('UNAVAILABLE') ||
        errStr.includes('high demand') ||
        errStr.includes('RESOURCE_EXHAUSTED') ||
        errStr.includes('quota') ||
        errStr.includes('rate limit');

      if (isTransient && attempt < maxRetries) {
        console.warn(`Gemini transient status on attempt ${attempt}. Waiting ${delay}ms before retrying...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }

      if (
        (err?.status === 503 ||
          err?.status === 429 ||
          errStr.includes('503') ||
          errStr.includes('429') ||
          errStr.includes('high demand') ||
          errStr.includes('quota') ||
          errStr.includes('RESOURCE_EXHAUSTED') ||
          errStr.includes('UNAVAILABLE')) &&
        params.model !== 'gemini-3.1-flash-lite'
      ) {
        console.warn(`Model ${params.model} encountered capacity/quota limit, falling back to gemini-3.1-flash-lite`);
        return await ai.models.generateContent({
          ...params,
          model: 'gemini-3.1-flash-lite',
        });
      }

      throw err;
    }
  }
}

export async function extractQuotationFromPdf(pdfBase64: string, apiKey: string): Promise<ExtractionResult> {
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const prompt1 = `You are a specialist MULTIVAC quotation document extractor.
Extract all order line items from the attached MULTIVAC quotation PDF.
Instructions:
1. Count and list all positions (Pos. 10, 20, 30...) across ALL pages. If a position is split across a page break, join the description lines into one partName.
2. For each position:
   - position: the item position number (e.g. "10", "20")
   - reference: the bold material number (keep as a STRING with leading zeros intact)
   - partName: the part description plus its dimension line (e.g. "Tension spring D1=9")
   - netPrice: per-unit "Net price" AFTER the customer discount (NOT the list price, NOT the line amount)
   - listPrice: list price per unit
   - quantity: quantity ordered/quoted
   - unit: unit code (PC, m, etc.)
   - lineAmount: the line total shown on the PDF
3. European numbers: 3,52 = 3.52; 1.234,56 = 1234.56. Convert commas to decimal points accurately.
4. invoiceAmount: the final "Invoice amount" (Total Exworks) on the quotation.
   quotationNumber: the "Document" number at the top of the quotation (e.g. 21400572), NOT the customer number and NOT the "Your quote request" reference.
5. ignoredLines: any sub-total, text or note lines without price and quantity.
6. Never guess. If anything is unclear, put it in the unclear array.`;

  const prompt2 = `You are an independent quality-assurance auditor reviewing this MULTIVAC quotation PDF.
Audit and extract every position with precision:
1. Identify each Pos. (10, 20, 30...) across all pages, stitching any multi-line or split position items.
2. Extract the exact bold material number as reference (string), the complete part name and dimensions, net unit price (post-discount unit price), list unit price, quantity, unit, and line total amount.
3. European decimal format (e.g. 1.250,50 -> 1250.50).
4. Extract the quotation's final invoice amount / Exworks total, and the quotation's Document number (not the customer number, not the quote-request reference).
5. Record ignored subtotal or comment lines in ignoredLines.
6. If any line or value is ambiguous or degraded, report in unclear array. Never invent numbers.`;

  // Call 1
  const call1Res = await callGeminiWithRetry(ai, {
    model: 'gemini-3.8-flash',
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType: 'application/pdf',
              data: pdfBase64,
            },
          },
          { text: prompt1 },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: extractionSchema,
      temperature: 0,
    },
  });

  // Small delay between calls
  await new Promise((r) => setTimeout(r, 600));

  // Call 2
  const call2Res = await callGeminiWithRetry(ai, {
    model: 'gemini-3.8-flash',
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType: 'application/pdf',
              data: pdfBase64,
            },
          },
          { text: prompt2 },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: extractionSchema,
      temperature: 0,
    },
  });

  const result1: QuotationExtraction = JSON.parse(call1Res.text || '{}');
  const result2: QuotationExtraction = JSON.parse(call2Res.text || '{}');

  // Field-by-field comparison
  const differences: string[] = [];

  if (String(result1.quotationNumber || '').trim() !== String(result2.quotationNumber || '').trim()) {
    differences.push(`Quotation number differs: Run 1 found "${result1.quotationNumber}", Run 2 found "${result2.quotationNumber}"`);
  }

  if (Math.abs((result1.invoiceAmount || 0) - (result2.invoiceAmount || 0)) > 0.01) {
    differences.push(`Invoice amount differs: Run 1 found ${result1.invoiceAmount}, Run 2 found ${result2.invoiceAmount}`);
  }

  if ((result1.positions || []).length !== (result2.positions || []).length) {
    differences.push(`Position count differs: Run 1 found ${result1.positions?.length || 0} items, Run 2 found ${result2.positions?.length || 0} items`);
  } else {
    for (let i = 0; i < result1.positions.length; i++) {
      const p1 = result1.positions[i];
      const p2 = result2.positions[i];
      if (p1.position !== p2.position) {
        differences.push(`Pos ${i + 1} position label mismatch: "${p1.position}" vs "${p2.position}"`);
      }
      if (p1.reference !== p2.reference) {
        differences.push(`Pos ${p1.position} reference mismatch: "${p1.reference}" vs "${p2.reference}"`);
      }
      if (Math.abs(p1.netPrice - p2.netPrice) > 0.01) {
        differences.push(`Pos ${p1.position} net price mismatch: ${p1.netPrice} vs ${p2.netPrice}`);
      }
      if (Math.abs(p1.quantity - p2.quantity) > 0.001) {
        differences.push(`Pos ${p1.position} quantity mismatch: ${p1.quantity} vs ${p2.quantity}`);
      }
      if (p1.unit?.toUpperCase() !== p2.unit?.toUpperCase()) {
        differences.push(`Pos ${p1.position} unit mismatch: "${p1.unit}" vs "${p2.unit}"`);
      }
      if (Math.abs(p1.lineAmount - p2.lineAmount) > 0.01) {
        differences.push(`Pos ${p1.position} line amount mismatch: ${p1.lineAmount} vs ${p2.lineAmount}`);
      }
    }
  }

  let finalExtraction: QuotationExtraction = result1;

  // If differences found, run Call 3 targeted reconciliation
  if (differences.length > 0) {
    console.log('Discrepancies found between Run 1 and Run 2, initiating Call 3 reconciliation:', differences);
    const prompt3 = `You are a senior auditor reconciling discrepancies between two extraction passes of this MULTIVAC quotation.
Specific differences identified:
${differences.join('\n')}

Carefully inspect the PDF specifically for these points and provide the 100% verified, definitive extraction.
If any value remains genuinely illegible or ambiguous on the document, add it to the unclear array. Never guess.`;

    const call3Res = await callGeminiWithRetry(ai, {
      model: 'gemini-3.8-flash',
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: 'application/pdf',
                data: pdfBase64,
              },
            },
            { text: prompt3 },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        responseSchema: extractionSchema,
        temperature: 0,
      },
    });

    const result3: QuotationExtraction = JSON.parse(call3Res.text || '{}');
    finalExtraction = result3;

    const remainingDifferences: string[] = [];
    if (result3.unclear && result3.unclear.length > 0) {
      remainingDifferences.push(...result3.unclear.map((u) => `Unclear item: ${u.item} (${u.reason})`));
    }

    if (remainingDifferences.length > 0) {
      return {
        success: false,
        uncertainties: remainingDifferences,
        extraction: finalExtraction,
        message: 'Differences remain after reconciliation. Cannot safely deliver file without verification.',
      };
    }
  }

  if (!String(finalExtraction.quotationNumber || '').trim()) {
    return {
      success: false,
      uncertainties: ['Quotation (Document) number could not be read from the PDF.'],
      extraction: finalExtraction,
      message: 'Quotation number missing. Cannot guess values.',
    };
  }

  // Check if any unclear items in final extraction
  if (finalExtraction.unclear && finalExtraction.unclear.length > 0) {
    return {
      success: false,
      uncertainties: finalExtraction.unclear.map((u) => `${u.item}: ${u.reason}`),
      extraction: finalExtraction,
      message: 'Unclear values in quotation document. Cannot guess values.',
    };
  }

  return {
    success: true,
    extraction: finalExtraction,
  };
}
