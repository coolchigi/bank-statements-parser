"""
parse_statements.py
-------------------
Parses RBC Advantage Banking PDF statements into a list of Transaction objects.

Strategy: use pdfplumber's extract_table() with explicit vertical column separators
derived by locating the exact x-positions of the header words on each page.
This is far more robust than word-level bucketing.

Primary API for backend use:
    parse_from_bytes(pdf_bytes: bytes, filename: str) -> List[Transaction]
"""

import re
import logging
from pathlib import Path
from datetime import date
from decimal import Decimal
from dataclasses import dataclass
from typing import Optional, List

import io

import pdfplumber

log = logging.getLogger(__name__)

# ─── CONFIGURATION ────────────────────────────────────────────────────────────

MONTH_MAP = {
    "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4,
    "May": 5, "Jun": 6, "Jul": 7, "Aug": 8,
    "Sep": 9, "Oct": 10, "Nov": 11, "Dec": 12,
}

# These are the FIXED column separator x-positions read directly from the PDF.
# Verified from debug output: same on every page of both statements.
# Separators define: | date | description | withdrawal | deposit | balance |
COL_SEPARATORS = [0, 55, 290, 390, 480, 620]

# Lines containing these strings signal end of the transaction table
FOOTER_MARKERS = [
    "Important information",
    "Protect your PIN",
    "Stay Informed",
    "Please check",
    "Registered trade-mark",
    "Closing Balance",
]

# Non-transaction rows to skip
SKIP_ROW_TEXTS = {
    "opening balance", "closing balance", "openingbalance", "closingbalance",
    "date", "description",  # header row remnants
}

# Transaction type prefixes — first token(s) of a genuine transaction description
TRANSACTION_TYPE_STARTS = [
    "payroll",
    "e-transfer",
    "online",
    "investment",
    "visa",
    "contactless",
    "to find",
    "online transfer",
]

# Pure merchant-name first words — these are NEVER the start of a new transaction
MERCHANT_ONLY_FIRST_WORDS = {
    "uber", "lyft", "walmart", "wal-mart", "amzn", "amazon", "shoppers",
    "massine", "thana", "africa", "geeland", "apple", "audible", "presto",
    "immigration", "vivianna", "the", "sp", "le", "rbcrewards",
    "momentive", "chimoneyws", "precious", "sabita", "mfh", "olivia",
    "tabitha", "chigo_e", "chimnomso", "mrsayo", "mrsama",
}

# Descriptions that are always a DEPOSIT (money IN)
DEPOSIT_DESCRIPTIONS = [
    "payroll deposit",
    "e-transfer - autodeposit",
    "autodeposit",
    "visa debit authorization expired",
    "visa debit auth reversal expired",
    "visa debit refund",
    "visa debit reversal",
]

# Descriptions that are always a WITHDRAWAL (money OUT)
WITHDRAWAL_DESCRIPTIONS = [
    "e-transfer sent",
    "investment ws",
    "to find & save",
    "to find and save",
    "contactless interac purchase",
    "visa debit purchase",
]

# Category rules: checked in order, first match wins
CATEGORY_RULES = [
    ("Income",            ["payroll deposit", "payrolldeposit"]),
    ("Investments",       ["ws investments", "wealthsimple"]),
    ("Savings",           ["find & save", "find and save"]),
    ("Rent",              ["sabita", "landlord"]),
    ("Groceries",         ["walmart", "wal-mart", "thana market", "africa world",
                            "geeland", "massine"]),
    ("Rideshare",         ["uber", "lyft"]),
    ("Subscriptions",     ["apple.com/bill", "audible", "amazon prime", "wix"]),
    ("Shopping",          ["amazon", "amzn", "uniqlo", "dollarama", "sp torras",
                            "sp quad lock"]),
    ("Food & Dining",     ["le poke", "naija jollo", "cake shop", "tabitha"]),
    ("Entertainment",     ["niagara skywheel", "skywheel"]),
    ("Health & Beauty",   ["vivianna skin", "shoppers drug", "shoppers"]),
    ("Transit",           ["presto"]),
    ("Government / Fees", ["immigration"]),
    ("Transfers Out",     ["e-transfer sent", "chimoney"]),
    ("Transfers In",      ["e-transfer - autodeposit", "autodeposit"]),
    ("Refunds",           ["visa debit refund", "auth reversal", "visa debit reversal",
                            "reversal expired"]),
    ("Other",             []),  # catch-all
]

# ─── DATA CLASSES ─────────────────────────────────────────────────────────────

@dataclass
class RawRow:
    raw_date:       str = ""
    raw_desc:       str = ""   # full description — may span multiple PDF lines
    raw_withdrawal: str = ""
    raw_deposit:    str = ""
    raw_balance:    str = ""
    page_num:       int = 0


@dataclass
class Transaction:
    date:             date
    description:      str        # full description (type line + merchant joined)
    type_line:        str        # transaction type (first description line)
    merchant:         str        # merchant name (second description line), may be ""
    direction:        str        # "Withdrawal" or "Deposit"
    amount:           Decimal
    balance:          Optional[Decimal]
    category:         str
    statement_period: str


# ─── REGEX ────────────────────────────────────────────────────────────────────

# Valid RBC date token: "10Dec", "5Jan", "23Feb" etc.
_DATE_RE = re.compile(r'^(\d{1,2})\s*([A-Za-z]{3})$')

# Trailing decimal amount at end of string (e.g. "Investment WS 30.00")
_TRAILING_AMOUNT_RE = re.compile(r'^(.*\S)\s+(\d{1,3}(?:,\d{3})*\.\d{2})$')

# Standalone decimal number (amount only, no text)
_AMOUNT_ONLY_RE = re.compile(r'^\d{1,3}(?:,\d{3})*\.\d{2}$')


# ─── TABLE EXTRACTION ─────────────────────────────────────────────────────────

def find_table_bbox(page) -> Optional[tuple]:
    """
    Find the bounding box of the transaction table on a page.
    Returns (x0, top, x1, bottom) or None if no table found.

    Strategy:
    - Top edge: y-position of the header row containing 'Date' + 'Description'
    - Bottom edge: y-position of the first footer marker, or page bottom
    """
    # Use tight x_tolerance=2 to avoid merging column header words together
    words = page.extract_words(x_tolerance=2, y_tolerance=3)
    if not words:
        return None

    table_top    = None
    table_bottom = page.height

    # Group words by approximate y-position to find the header row
    from collections import defaultdict
    lines: dict[int, list] = defaultdict(list)
    for w in words:
        bucket = round(w["top"] / 2) * 2   # 2pt buckets
        lines[bucket].append(w)

    for y_bucket in sorted(lines):
        line_words = lines[y_bucket]
        texts = [w["text"] for w in line_words]
        joined = " ".join(texts)
        # Header row contains both "Date" and "Description" (or "Withdrawals")
        if ("Date" in texts or any("Date" in t for t in texts)) and \
           any("Withdrawal" in t or "Description" in t for t in texts):
            # Use the minimum top of words on this line
            table_top = min(w["top"] for w in line_words)
            break

    if table_top is None:
        return None

    # Find footer boundary
    footer_keywords = [
        "importantinformation", "important", "protectyour", "closingbalance",
        "closing", "stayinformed", "pleasecheck", "registeredtrade"
    ]
    for w in words:
        if w["top"] <= table_top:
            continue
        text_lower = w["text"].lower().replace(" ", "")
        if any(kw in text_lower for kw in footer_keywords):
            table_bottom = w["top"]
            break

    return (0, table_top, page.width, table_bottom)


def find_col_separators(page) -> List[float]:
    """
    Locate the exact x-positions of column separators from the header row.
    Falls back to hardcoded COL_SEPARATORS if header not found.

    RBC columns: Date | Description | Withdrawals | Deposits | Balance
    We use the LEFT edge of each header word as the column separator.
    """
    words = page.extract_words(x_tolerance=2, y_tolerance=3)

    header_y = None
    date_x = desc_x = with_x = dep_x = bal_x = None

    # Find the header row — look for a line containing both "Date" and "Description"
    from collections import defaultdict
    lines: dict[int, list] = defaultdict(list)
    for w in words:
        bucket = round(w["top"] / 2) * 2
        lines[bucket].append(w)

    for y_bucket in sorted(lines):
        line_words = lines[y_bucket]
        texts = [w["text"] for w in line_words]
        if any("Date" in t for t in texts) and \
           any("Withdrawal" in t or "Description" in t for t in texts):
            header_y = min(w["top"] for w in line_words)
            for w in line_words:
                t = w["text"]
                if "Date" in t and w["x0"] < 60:
                    date_x = w["x0"]
                if "Description" in t:
                    desc_x = w["x0"]
                if "Withdrawal" in t:
                    with_x = w["x0"]
                if "Deposit" in t and "e-Transfer" not in t:
                    dep_x = w["x0"]
                if "Balance" in t:
                    bal_x = w["x0"]
            break

    if header_y is None:
        log.debug("Header row not found — using hardcoded separators")
        return COL_SEPARATORS

    if all(v is not None for v in [date_x, desc_x, with_x, dep_x, bal_x]):
        separators = sorted([0, date_x, desc_x, with_x, dep_x, bal_x, page.width])
        log.debug(f"Detected separators: {separators}")
        return separators

    log.debug("Partial header detection — using hardcoded separators")
    return COL_SEPARATORS


def extract_table_rows(page, page_num: int) -> List[dict]:
    """
    Extract raw table rows from a page as a list of dicts with keys:
    date, desc, withdrawal, deposit, balance.

    Uses pdfplumber's extract_table() with explicit vertical separators.
    """
    bbox = find_table_bbox(page)
    if bbox is None:
        log.debug(f"Page {page_num}: no table found")
        return []

    separators = find_col_separators(page)

    # Crop to table area
    cropped = page.within_bbox(bbox)

    # Ensure separators always span the full page width
    if separators[-1] < page.width - 1:
        separators = list(separators) + [page.width]

    # Build table settings using our column separators as explicit vertical lines
    table_settings = {
        "vertical_strategy":      "explicit",
        "horizontal_strategy":    "text",
        "explicit_vertical_lines": separators,
        "snap_tolerance":         3,
        "join_tolerance":         3,
        "edge_min_length":        3,
        "min_words_vertical":     1,
        "min_words_horizontal":   1,
        "text_tolerance":         3,
        "text_x_tolerance":       3,
        "text_y_tolerance":       3,
        "intersection_tolerance": 3,
    }

    table = cropped.extract_table(table_settings)
    if not table:
        log.debug(f"Page {page_num}: extract_table() returned nothing")
        return []

    rows = []
    for row in table:
        if not row:
            continue
        # Normalise: strip whitespace, replace None with ""
        cells = [c.strip() if c else "" for c in row]

        # The table always has these columns in order:
        # [date, description, withdrawal, deposit] — balance may or may not appear
        # We match by position, padding to at least 5 cells
        while len(cells) < 5:
            cells.append("")

        date_cell = cells[0]
        desc_cell = cells[1]
        with_cell = cells[2]
        dep_cell  = cells[3]
        bal_cell  = cells[4]

        rows.append({
            "date":       date_cell,
            "desc":       desc_cell,
            "withdrawal": with_cell,
            "deposit":    dep_cell,
            "balance":    bal_cell,
            "page_num":   page_num,
        })

    return rows


# ─── ROW CLEANING ─────────────────────────────────────────────────────────────

def clean_amount(raw: str) -> str:
    """
    pdfplumber sometimes puts the amount inside the description cell when
    columns are tight. If an amount-only string ends up in desc, extract it.
    Also normalises multi-line cell text (joins with space).
    """
    if not raw:
        return ""
    # Normalise newlines from multi-line cells
    cleaned = " ".join(raw.split())
    return cleaned


def is_valid_date(text: str) -> bool:
    return bool(_DATE_RE.match(text.strip())) if text else False


def is_skip_row(date_cell: str, desc_cell: str) -> bool:
    """True for header rows, footer rows, and blank rows."""
    combined = (date_cell + " " + desc_cell).lower().strip()
    if not combined:
        return True
    for skip in SKIP_ROW_TEXTS:
        if skip in combined:
            return True
    # Header row: contains "description" or "withdrawals"
    if "withdrawals" in combined or ("date" in combined and "description" in combined):
        return True
    return False


def is_new_transaction(date_cell: str, desc_cell: str,
                        with_cell: str, dep_cell: str) -> bool:
    """
    True if this row starts a new transaction.
    - Has a valid date, OR
    - Description starts with a known transaction type keyword, OR
    - Has an amount and description's first word isn't a pure merchant name
    """
    if is_valid_date(date_cell):
        return True

    desc_lower = desc_cell.lower().strip()
    if any(desc_lower.startswith(kw) for kw in TRANSACTION_TYPE_STARTS):
        return True

    has_amount = bool(with_cell.strip() or dep_cell.strip())
    if has_amount and desc_lower:
        first_word = desc_lower.split()[0]
        if first_word not in MERCHANT_ONLY_FIRST_WORDS:
            return True

    return False


# ─── RAW ROW ASSEMBLY ─────────────────────────────────────────────────────────

def assemble_raw_rows(table_rows: List[dict]) -> List[RawRow]:
    """
    Merge multi-line table rows into single RawRow objects.

    pdfplumber's horizontal_strategy="text" creates one row per text line,
    so a two-line transaction (type + merchant) appears as two consecutive rows.
    We merge them here.
    """
    raw_rows: List[RawRow] = []
    current: Optional[RawRow] = None

    for r in table_rows:
        date_cell = clean_amount(r["date"])
        desc_cell = clean_amount(r["desc"])
        with_cell = clean_amount(r["withdrawal"])
        dep_cell  = clean_amount(r["deposit"])
        bal_cell  = clean_amount(r["balance"])
        page_num  = r["page_num"]

        # Skip header/footer/blank rows
        if is_skip_row(date_cell, desc_cell):
            continue

        # Reject barcodes/serials in date column
        if date_cell and not is_valid_date(date_cell):
            date_cell = ""

        # Handle embedded amounts in description (pdfplumber table quirk)
        if desc_cell and not with_cell and not dep_cell:
            m = _TRAILING_AMOUNT_RE.match(desc_cell)
            if m:
                desc_cell = m.group(1).strip()
                amt_str   = m.group(2)
                desc_lower = desc_cell.lower()
                if any(kw in desc_lower for kw in DEPOSIT_DESCRIPTIONS):
                    dep_cell  = amt_str
                else:
                    with_cell = amt_str

        # Pure balance-only row — attach to current
        if bal_cell and not desc_cell and not with_cell and not dep_cell and not date_cell:
            if current and not current.raw_balance:
                current.raw_balance = bal_cell
            continue

        # Fully empty row
        if not any([date_cell, desc_cell, with_cell, dep_cell, bal_cell]):
            continue

        if is_new_transaction(date_cell, desc_cell, with_cell, dep_cell):
            if current:
                raw_rows.append(current)
            current = RawRow(
                raw_date       = date_cell,
                raw_desc       = desc_cell,
                raw_withdrawal = with_cell,
                raw_deposit    = dep_cell,
                raw_balance    = bal_cell,
                page_num       = page_num,
            )
        else:
            # Continuation line — append to current description (merchant name)
            if current:
                if desc_cell:
                    if current.raw_desc:
                        current.raw_desc = current.raw_desc + " — " + desc_cell
                    else:
                        current.raw_desc = desc_cell
                if with_cell and not current.raw_withdrawal:
                    current.raw_withdrawal = with_cell
                if dep_cell and not current.raw_deposit:
                    current.raw_deposit = dep_cell
                if bal_cell and not current.raw_balance:
                    current.raw_balance = bal_cell

    if current:
        raw_rows.append(current)

    return raw_rows


# ─── DATE FILLING ─────────────────────────────────────────────────────────────

def fill_dates(raw_rows: List[RawRow], year_map: dict) -> List[Optional[date]]:
    """Forward-fill sparse dates. Returns a resolved date per row."""
    resolved: List[Optional[date]] = []
    last_date: Optional[date] = None

    for row in raw_rows:
        if row.raw_date:
            m = _DATE_RE.match(row.raw_date.strip())
            if m:
                day_str   = m.group(1)
                month_str = m.group(2)[:3].capitalize()
                year  = year_map.get(month_str)
                month = MONTH_MAP.get(month_str)
                if year and month:
                    try:
                        last_date = date(year, month, int(day_str))
                    except ValueError:
                        log.warning(f"Invalid date: {row.raw_date!r}")
        resolved.append(last_date)

    return resolved


# ─── DIRECTION & AMOUNT ───────────────────────────────────────────────────────

def resolve_direction(raw_desc: str, raw_w: str, raw_d: str) -> str:
    """Determine Withdrawal or Deposit from which column has the amount."""
    has_w = bool(raw_w.strip())
    has_d = bool(raw_d.strip())

    if has_w and not has_d:
        return "Withdrawal"
    if has_d and not has_w:
        return "Deposit"
    if has_w and has_d:
        log.warning(f"Both columns populated for: {raw_desc!r} — using Withdrawal")
        return "Withdrawal"

    # Neither: fall back to keywords
    desc_lower = raw_desc.lower()
    if any(kw in desc_lower for kw in DEPOSIT_DESCRIPTIONS):
        return "Deposit"
    if any(kw in desc_lower for kw in WITHDRAWAL_DESCRIPTIONS):
        return "Withdrawal"

    log.warning(f"Cannot determine direction for: {raw_desc!r} — defaulting to Withdrawal")
    return "Withdrawal"


def parse_amount(raw: str) -> Optional[Decimal]:
    """Parse '1,234.56' or '$1,234.56' → Decimal."""
    if not raw:
        return None
    cleaned = re.sub(r"[$,\s]", "", raw)
    if not cleaned:
        return None
    try:
        return Decimal(cleaned)
    except Exception:
        log.warning(f"Could not parse amount: {raw!r}")
        return None


# ─── CATEGORIZATION ───────────────────────────────────────────────────────────

def categorize(description: str, direction: str) -> str:
    """Assign spending category. First match wins."""
    desc_lower = description.lower()

    # Online Banking transfers: direction determines in vs out
    if "online banking transfer" in desc_lower or "online transfer to deposit" in desc_lower:
        return "Transfers Out" if direction == "Withdrawal" else "Transfers In"

    for category, keywords in CATEGORY_RULES:
        if not keywords:
            return category
        if any(kw in desc_lower for kw in keywords):
            return category

    return "Other"


# ─── TRANSACTION ASSEMBLY ─────────────────────────────────────────────────────

def split_description(raw_desc: str) -> tuple[str, str]:
    """
    Split a full description into (type_line, merchant).
    The separator ' — ' is inserted during assemble_raw_rows for two-line descriptions.
    """
    if " — " in raw_desc:
        parts = raw_desc.split(" — ", 1)
        return parts[0].strip(), parts[1].strip()
    return raw_desc.strip(), ""


def build_transactions(
    raw_rows: List[RawRow],
    resolved_dates: List[Optional[date]],
    period: str,
) -> List[Transaction]:
    transactions = []

    for row, resolved_date in zip(raw_rows, resolved_dates):
        if resolved_date is None:
            log.warning(f"Skipping row with no date: {row.raw_desc!r}")
            continue

        direction = resolve_direction(row.raw_desc, row.raw_withdrawal, row.raw_deposit)
        raw_amount = row.raw_withdrawal if direction == "Withdrawal" else row.raw_deposit
        amount = parse_amount(raw_amount)

        if amount is None:
            log.warning(
                f"Skipping — no amount: desc={row.raw_desc!r} "
                f"w={row.raw_withdrawal!r} d={row.raw_deposit!r} "
                f"on {resolved_date} (page {row.page_num})"
            )
            continue

        if amount <= 0:
            log.warning(f"Skipping non-positive amount {amount}: {row.raw_desc!r}")
            continue

        type_line, merchant = split_description(row.raw_desc)

        t = Transaction(
            date             = resolved_date,
            description      = row.raw_desc,
            type_line        = type_line,
            merchant         = merchant,
            direction        = direction,
            amount           = amount,
            balance          = parse_amount(row.raw_balance),
            category         = categorize(row.raw_desc, direction),
            statement_period = period,
        )
        transactions.append(t)

    return transactions


# ─── VALIDATION ───────────────────────────────────────────────────────────────

def validate(transactions: List[Transaction]) -> bool:
    issues = []

    dec_jan = [t for t in transactions if t.statement_period == "Dec 2025 – Jan 2026"]
    jan_feb = [t for t in transactions if t.statement_period == "Jan 2026 – Feb 2026"]

    if not (70 <= len(dec_jan) <= 110):
        issues.append(f"Dec–Jan count {len(dec_jan)} outside expected range 70–110")
    if not (45 <= len(jan_feb) <= 90):
        issues.append(f"Jan–Feb count {len(jan_feb)} outside expected range 45–90")

    for i, t in enumerate(transactions):
        if t.amount is None or t.amount <= 0:
            issues.append(f"Row {i} ({t.date}): bad amount {t.amount} — {t.type_line!r}")

    for label, group in [("Dec–Jan", dec_jan), ("Jan–Feb", jan_feb)]:
        prev = None
        for t in group:
            if prev and t.date < prev:
                issues.append(f"{label}: date out of order — {t.date} after {prev}")
            prev = t.date

    if issues:
        for issue in issues:
            log.warning(f"VALIDATION: {issue}")
        return False

    log.info("Validation passed — all checks OK")
    return True


# ─── YEAR MAP DETECTION ───────────────────────────────────────────────────────

# Regex to find "From MonthDD, YYYY to MonthDD, YYYY" in PDF header text
_PERIOD_RE = re.compile(
    r'From\s+([A-Za-z]+)\s*\d+,\s*(\d{4})\s+to\s+([A-Za-z]+)\s*\d+,\s*(\d{4})',
    re.IGNORECASE
)

def detect_year_map(pdf) -> tuple[dict, str]:
    """
    Read the first page of an open pdfplumber PDF to detect the statement period.
    Returns (year_map, period_label).
    Falls back to current year if detection fails.
    """
    from datetime import datetime
    current_year = datetime.now().year

    try:
        first_page_text = pdf.pages[0].extract_text() or ""
        m = _PERIOD_RE.search(first_page_text)
        if m:
            start_month = m.group(1)[:3].capitalize()
            start_year  = int(m.group(2))
            end_month   = m.group(3)[:3].capitalize()
            end_year    = int(m.group(4))

            year_map = {start_month: start_year, end_month: end_year}
            period   = f"{start_month} {start_year} – {end_month} {end_year}"
            log.info(f"Detected period: {period}")
            return year_map, period
    except Exception as e:
        log.warning(f"Period detection failed: {e}")

    fallback_year_map = {m: current_year for m in MONTH_MAP}
    return fallback_year_map, f"Unknown {current_year}"


# ─── MAIN PARSE ENTRY POINTS ──────────────────────────────────────────────────

def parse_from_bytes(pdf_bytes: bytes, filename: str = "statement.pdf") -> List[Transaction]:
    """
    Parse a single PDF statement from raw bytes.
    This is the primary entry point for the backend API.

    Args:
        pdf_bytes: Raw PDF file content
        filename:  Original filename (used only for logging)

    Returns:
        List of Transaction objects
    """
    all_table_rows = []

    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        year_map, period = detect_year_map(pdf)

        for page_num, page in enumerate(pdf.pages, start=1):
            if page_num >= 5:   # page 5 is boilerplate only
                break
            rows = extract_table_rows(page, page_num)
            all_table_rows.extend(rows)

    raw_rows       = assemble_raw_rows(all_table_rows)
    resolved_dates = fill_dates(raw_rows, year_map)
    transactions   = build_transactions(raw_rows, resolved_dates, period)

    log.info(f"Parsed {len(transactions)} transactions from {filename}")
    return transactions


def parse_from_path(path: Path, year_map: dict, period: str) -> List[Transaction]:
    """Parse a PDF from a file path. Used by the local CLI (main.py)."""
    all_table_rows = []

    with pdfplumber.open(path) as pdf:
        for page_num, page in enumerate(pdf.pages, start=1):
            if page_num >= 5:
                break
            rows = extract_table_rows(page, page_num)
            all_table_rows.extend(rows)

    raw_rows       = assemble_raw_rows(all_table_rows)
    resolved_dates = fill_dates(raw_rows, year_map)
    transactions   = build_transactions(raw_rows, resolved_dates, period)

    log.info(f"Parsed {len(transactions):>3} transactions from {path.name}")
    return transactions
