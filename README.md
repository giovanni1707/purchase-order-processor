# MULTIVAC Purchase Order

Upload a MULTIVAC quotation PDF and `Template_Purchase_Order_2026.xlsx`, type the EUR → MUR rate, and get the workbook back with the **Order list** and **PO Multivac** sheets filled. Every other sheet is returned byte-for-byte unchanged.

* Extraction: server-side Gemini (`/api/extract`), run twice and reconciled; ambiguity stops the run.
* Excel: the package XML is edited directly with JSZip (no load-and-save library), so hidden sheets, logos, comments, external links and custom XML survive.
* Verification: the saved file is re-opened and checked (package integrity, formulas, totals vs. the quotation's Invoice amount, no Excel errors, HyperFormula recalculation). Download is only offered when every check passes.

```
npm install
cp .env.example .env   # set GEMINI_API_KEY
npm run dev
npm run test:engine    # engine + verifier against a template, no API key needed
```
