import { extractQuotationFromPdf } from '../src/services/geminiExtractor';

export const config = {
  maxDuration: 60,
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

export default async function handler(req: any, res: any) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: `Method ${req.method} not allowed. Send a POST request with { pdfBase64 }.`,
    });
  }

  try {
    let body = req.body;

    // Handle string or buffer bodies if Vercel did not auto-parse JSON
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        return res.status(400).json({
          success: false,
          error: 'Invalid JSON request payload.',
        });
      }
    } else if (Buffer.isBuffer(body)) {
      try {
        body = JSON.parse(body.toString('utf8'));
      } catch {
        return res.status(400).json({
          success: false,
          error: 'Invalid JSON request payload.',
        });
      }
    } else if (!body && typeof req.on === 'function') {
      // Fallback: read incoming stream if body was not consumed
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) {
        try {
          body = JSON.parse(raw);
        } catch {
          return res.status(400).json({
            success: false,
            error: 'Invalid JSON request payload.',
          });
        }
      }
    }

    const { pdfBase64 } = body || {};
    if (!pdfBase64) {
      return res.status(400).json({
        success: false,
        error: 'Quotation PDF base64 is required in request body.',
      });
    }

    const apiKey = process.env.GEMINI_API_KEY || process.env.API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        success: false,
        error:
          'GEMINI_API_KEY is not configured in Vercel. Please add GEMINI_API_KEY to your Vercel Project Settings > Environment Variables, and redeploy.',
      });
    }

    const result = await extractQuotationFromPdf(pdfBase64, apiKey);

    // Return 200 with result payload (can be success: true or success: false if uncertainties exist)
    return res.status(200).json(result);
  } catch (err: any) {
    console.error('Vercel extract handler error:', err);
    let message = 'Failed to extract quotation data.';
    const errStr = String(err?.message || err);
    if (
      err?.status === 429 ||
      errStr.includes('429') ||
      errStr.includes('quota') ||
      errStr.includes('RESOURCE_EXHAUSTED')
    ) {
      message = 'Gemini API quota exceeded. Please check your API key quota or try again in a moment.';
    } else if (errStr.includes('API_KEY_INVALID') || errStr.includes('API key not valid')) {
      message = 'Invalid Gemini API key. Please check your GEMINI_API_KEY environment variable.';
    } else if (err?.message) {
      message = err.message;
    }

    return res.status(500).json({
      success: false,
      error: message,
    });
  }
}
