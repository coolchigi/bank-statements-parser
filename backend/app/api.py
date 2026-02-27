"""
api.py
------
FastAPI backend for the RBC bank statement parser.

Endpoints:
    GET  /api/health         — liveness check
    POST /api/parse          — upload one or more PDFs, returns JSON transactions
    POST /api/export         — upload one or more PDFs, returns an Excel file
"""

import logging
from typing import List

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

from app.parser.parse_statements import parse_from_bytes
from app.parser.export_excel import export

# ─── LOGGING ──────────────────────────────────────────────────────────────────

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# ─── APP ──────────────────────────────────────────────────────────────────────

app = FastAPI(title="RBC Statement Parser", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── SCHEMAS ──────────────────────────────────────────────────────────────────

class TransactionOut(BaseModel):
    date:             str
    type_line:        str
    merchant:         str
    direction:        str
    amount:           float
    balance:          float | None
    category:         str
    description:      str
    statement_period: str


class ParseResponse(BaseModel):
    count:        int
    transactions: List[TransactionOut]


# ─── HELPERS ──────────────────────────────────────────────────────────────────

async def _read_pdfs(files: List[UploadFile]):
    """Read uploaded files and return list of (bytes, filename) tuples."""
    results = []
    for f in files:
        if not f.filename or not f.filename.lower().endswith(".pdf"):
            raise HTTPException(status_code=400, detail=f"Only PDF files are accepted, got: {f.filename!r}")
        data = await f.read()
        if not data:
            raise HTTPException(status_code=400, detail=f"Uploaded file is empty: {f.filename!r}")
        results.append((data, f.filename))
    return results


# ─── ROUTES ───────────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.post("/api/parse", response_model=ParseResponse)
async def parse(files: List[UploadFile] = File(...)):
    """
    Upload one or more RBC PDF statements.
    Returns all transactions as JSON.
    """
    if not files:
        raise HTTPException(status_code=400, detail="At least one PDF file is required.")

    pdf_data = await _read_pdfs(files)
    all_transactions = []

    for pdf_bytes, filename in pdf_data:
        try:
            txns = parse_from_bytes(pdf_bytes, filename)
            all_transactions.extend(txns)
        except Exception as e:
            log.exception(f"Failed to parse {filename!r}")
            raise HTTPException(status_code=422, detail=f"Failed to parse {filename!r}: {e}")

    # Sort chronologically across all statements
    all_transactions.sort(key=lambda t: t.date)

    out = [
        TransactionOut(
            date             = t.date.isoformat(),
            type_line        = t.type_line,
            merchant         = t.merchant,
            direction        = t.direction,
            amount           = float(t.amount),
            balance          = float(t.balance) if t.balance is not None else None,
            category         = t.category,
            description      = t.description,
            statement_period = t.statement_period,
        )
        for t in all_transactions
    ]

    return ParseResponse(count=len(out), transactions=out)


@app.post("/api/export")
async def export_excel(files: List[UploadFile] = File(...)):
    """
    Upload one or more RBC PDF statements.
    Returns a formatted Excel workbook as a file download.
    """
    if not files:
        raise HTTPException(status_code=400, detail="At least one PDF file is required.")

    pdf_data = await _read_pdfs(files)
    all_transactions = []

    for pdf_bytes, filename in pdf_data:
        try:
            txns = parse_from_bytes(pdf_bytes, filename)
            all_transactions.extend(txns)
        except Exception as e:
            log.exception(f"Failed to parse {filename!r}")
            raise HTTPException(status_code=422, detail=f"Failed to parse {filename!r}: {e}")

    all_transactions.sort(key=lambda t: t.date)

    try:
        xlsx_bytes = export(all_transactions)
    except Exception as e:
        log.exception("Excel export failed")
        raise HTTPException(status_code=500, detail=f"Excel export failed: {e}")

    return Response(
        content=xlsx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": "attachment; filename=rbc_transactions.xlsx"},
    )
