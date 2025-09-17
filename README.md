# RBC PDF Bank Statement Parser

A web app for parsing RBC (Royal Bank of Canada) PDF bank statements in the browser. Built with React, Vite, TypeScript, and [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist).

---

## Features

- **Upload** an RBC PDF statement
- **Extract** raw text for debugging
- **Test** parsing patterns (see console output)
- **Parse** transactions into a structured table (date, description, amount, balance, type)
- **View** parsed transactions in a table with deposit/withdrawal highlighting

---

## Quick Start

1. **Install dependencies**
	```sh
	npm install
	```

2. **Run the development server**
	```sh
	npm run dev
	```

3. **Open the app**
	- Visit [http://localhost:5173](http://localhost:5173) in your browser.

---

## Usage

1. **Upload** your RBC PDF statement using the file input.
2. Use one of the action buttons:
	- **Extract Raw Text**: Dumps all PDF text to the browser console.
	- **Test Patterns**: Runs pattern matching and logs results to the console.
	- **Parse Transactions**: Extracts transactions and displays them in a table.

---

## Project Structure

```
pdf-parser/
├── src/
│   ├── components/
│   │   └── PdfUpload.tsx      # Main UI component for uploading and parsing
│   ├── lib/
│   │   └── rbcPdfParser.ts    # RBC PDF parsing logic (uses pdfjs-dist)
│   ├── App.tsx                # App entry point
│   ├── main.tsx               # React root
│   ├── index.css              # Global styles
│   └── App.css                # App-specific styles
├── public/
│   └── ...                    # Static assets (if needed)
├── package.json
├── vite.config.ts
└── README.md
```

---

## Parsing Logic

- **PDF Parsing**: Uses `pdfjs-dist` to extract text from PDF files.
- **Transaction Detection**: Custom logic in [`src/lib/rbcPdfParser.ts`](src/lib/rbcPdfParser.ts) identifies transaction rows, dates, descriptions, amounts, and balances using regular expressions and context.
- **UI**: [`src/components/PdfUpload.tsx`](src/components/PdfUpload.tsx) provides file upload, action buttons, and a results table.

---

## Customization

- **Patterns**: To support other banks or statement formats, modify the regex patterns in [`rbcPdfParser.ts`](src/lib/rbcPdfParser.ts).
- **Styling**: Customize styles in your CSS files as needed.

---

## Troubleshooting

- **PDF Worker**: The app uses Vite's `?url` import to load the PDF.js worker. No manual worker setup is needed.
- **Background Color**: The default background is set in [`src/index.css`](src/index.css) and can be changed as needed.

---

## License

MIT

---

**Maintainer:** [coolchigi](https://github.com/coolchigi)