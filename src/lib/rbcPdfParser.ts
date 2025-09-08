import * as pdfjsLib from 'pdfjs-dist';

import pdfjsWorkerURL from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerURL;

export interface Transaction {
  date: string;
  description: string;
  amount: number; // Positive for deposits, negative for withdrawals
  type: 'deposit' | 'withdrawal';
  balance?: number;
  category?: string;
  rawLine: string;
}

export class RBCPdfParser {
  // 0. Debug function - extract and display raw text (like before)
  async extractText(file: File): Promise<void> {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
    
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      
      console.log(`\n=== PAGE ${pageNum} ===`);
      
      textContent.items.forEach((item: any, index: number) => {
        console.log(`${index}: "${item.str}"`);
      });
    }
  }

  // 1. Basic PDF text extraction
  async extractAllTextItems(file: File): Promise<string[]> {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
    
    const allItems: string[] = [];
    
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      
      textContent.items.forEach((item: any) => {
        allItems.push(item.str);
      });
    }
    
    return allItems;
  }

  // 2. Check if text item is a date
  isDate(text: string): boolean {
    return /^\d{1,2} \w{3}$/.test(text);
  }

  // 3. Check if text item is a transaction description
  isTransactionDescription(text: string): boolean {
    const patterns = [
      /^e-Transfer (received|sent)/,
      /^Visa Debit purchase/,
      /^Online Banking (transfer|payment|foreign exchange)/,
      /^Payroll Deposit/,
      /^to Find & Save$/,
      /^Investment/,
      /^Contactless Interac purchase/,
      /^ATM withdrawal/,
      /^Misc Payment/
    ];
    
    return patterns.some(pattern => pattern.test(text));
  }

  // 4. Check if text item is a reference code
  isReferenceCode(text: string): boolean {
    // Reference codes are typically 8-12 alphanumeric characters
    // BUT exclude common words and obvious non-reference patterns
    if (!/^[A-Za-z0-9]{6,12}$/.test(text)) return false;
    if (this.isAmount(text)) return false;
    if (this.isDate(text)) return false;
    
    // Exclude obvious non-reference words
    const excludeWords = ['Description', 'Withdrawals', 'Deposits', 'Balance', 'Date'];
    if (excludeWords.includes(text)) return false;
    
    // Reference codes usually have mixed case or are all caps
    return true;
  }

  // 5. Check if text item is a monetary amount
  isAmount(text: string): boolean {
    if (!/^\d{1,3}(?:,\d{3})*(?:\.\d{2})?$/.test(text)) return false;
    
    const numericValue = parseFloat(text.replace(/,/g, ''));
    
    // Filter out obviously non-monetary numbers
    // Account numbers, reference numbers, etc.
    if (numericValue < 0.01) return false;  // Too small
    if (numericValue > 1000000) return false;  // Too large
    if (text.length <= 3 && !text.includes('.')) return false;  // "008", "123" etc.
    
    return true;
  }

  // 6. Check if amount is likely a balance (large number with comma)
  isLikelyBalance(text: string): boolean {
    if (!this.isAmount(text)) return false;
    const numericValue = parseFloat(text.replace(/,/g, ''));
    return numericValue > 1000 && text.includes(',');
  }

  // 7. Find the starting index of transaction data
  findTransactionStartIndex(items: string[]): number {
    for (let i = 0; i < items.length; i++) {
      if (items[i] === "Opening Balance") {
        return i + 1;
      }
    }
    return -1;
  }

  // 8. Find the ending index of transaction data
  findTransactionEndIndex(items: string[], startIndex: number): number {
    for (let i = startIndex; i < items.length; i++) {
      if (items[i].includes("Please check this Account Statement")) {
        return i;
      }
    }
    return items.length;
  }

  // 9. Check if transaction type is a deposit
  isDepositType(description: string): boolean {
    const depositPatterns = [
      /e-Transfer received/,
      /Payroll Deposit/,
      /Online Banking foreign exchange/,
      /refund/,
      /reversal/
    ];
    
    return depositPatterns.some(pattern => pattern.test(description));
  }

  // 10. Check if transaction type is a withdrawal
  isWithdrawalType(description: string): boolean {
    const withdrawalPatterns = [
      /e-Transfer sent/,
      /Visa Debit purchase/,
      /Online Banking (payment|transfer)/,
      /to Find & Save/,
      /Investment/,
      /Contactless Interac purchase/,
      /ATM withdrawal/,
      /Misc Payment/
    ];
    
    return withdrawalPatterns.some(pattern => pattern.test(description));
  }

  // Test function to verify our pattern detection
  async testPatterns(file: File): Promise<void> {
    const items = await this.extractAllTextItems(file);
    
    console.log("\n=== PATTERN TESTING ===");
    
    // Test first 200 items
    for (let i = 0; i < Math.min(200, items.length); i++) {
      const item = items[i];
      if (item.trim() === "") continue;
      
      const tests = {
        date: this.isDate(item),
        transaction: this.isTransactionDescription(item),
        reference: this.isReferenceCode(item),
        amount: this.isAmount(item),
        balance: this.isLikelyBalance(item)
      };
      
      const matches = Object.entries(tests)
        .filter(([key, value]) => value)
        .map(([key]) => key);
      
      if (matches.length > 0) {
        console.log(`${i}: "${item}" -> ${matches.join(', ')}`);
      }
    }
  }
}