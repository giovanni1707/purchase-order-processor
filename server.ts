import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  extractQuotationFromPdf,
  type PositionItem,
  type IgnoredLine,
  type UnclearLine,
  type QuotationExtraction,
  type ExtractionResult,
} from './src/services/geminiExtractor';

dotenv.config({ override: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type { PositionItem, IgnoredLine, UnclearLine, QuotationExtraction, ExtractionResult };

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

function getApiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.API_KEY;
}

// Extraction endpoint (supports both /api/extract and /extract)
app.post(['/api/extract', '/extract'], async (req, res) => {
  try {
    const { pdfBase64 } = req.body || {};
    if (!pdfBase64) {
      return res.status(400).json({ success: false, error: 'Quotation PDF base64 is required.' });
    }

    const key = getApiKey();
    if (!key) {
      return res.status(500).json({
        success: false,
        error: 'GEMINI_API_KEY is not configured on the server. Please set GEMINI_API_KEY.',
      });
    }

    const result = await extractQuotationFromPdf(pdfBase64, key);
    return res.json(result);
  } catch (err: any) {
    console.error('Extraction error:', err);
    let friendlyMessage = 'Failed to extract quotation data.';
    const errStr = String(err?.message || err);
    if (
      err?.status === 429 ||
      errStr.includes('429') ||
      errStr.includes('quota') ||
      errStr.includes('RESOURCE_EXHAUSTED')
    ) {
      friendlyMessage = 'Gemini API quota exceeded. Please check your API key quota or try again in a moment.';
    } else if (errStr.includes('API_KEY_INVALID') || errStr.includes('API key not valid')) {
      friendlyMessage = 'Invalid Gemini API key. Please check your GEMINI_API_KEY configuration.';
    } else if (err?.message) {
      friendlyMessage = err.message;
    }
    return res.status(500).json({
      success: false,
      error: friendlyMessage,
    });
  }
});

// Vite or static serving
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
  });
}

// Start dev server unless in serverless context
if (!process.env.VERCEL) {
  startServer();
}

export default app;
