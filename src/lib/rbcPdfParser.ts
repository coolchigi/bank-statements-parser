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
    const rbcPatterns = [
      /^e-Transfer (received|sent)/,
      /^Visa Debit purchase - \d+/,
      /^Online Banking (transfer|payment|foreign exchange) - \d+/,
      /^Payroll Deposit [A-Z]/,
      /^to Find & Save$/,
      /^Investment [A-Z]/,
      /^Contactless Interac purchase - \d+/,
      /^ATM withdrawal - \d+/,
      /^Misc Payment [A-Z]/,
      /^Cash withdrawal BR TO BR/
    ];
    
    return rbcPatterns.some(pattern => pattern.test(text));
  }

  // 4. Check if text item is a reference code
  isReferenceCode(text: string, previousItem: string): boolean {
    // Only check if previous item was an e-Transfer
    if (!/e-Transfer (received|sent)/.test(previousItem)) return false;
    
    // RBC e-Transfer codes: 6-8 mixed case alphanumeric
    return /^[A-Za-z0-9]{6,8}$/.test(text) && 
           text !== text.toLowerCase() && // Has some caps
           text !== text.toUpperCase();   // Not all caps
  }

  // 5. Check if text item is a monetary amount
  isAmount(text: string): boolean {
    // RBC amounts: Always have decimal or are whole dollars
    if (!/^\d{1,3}(?:,\d{3})*(?:\.\d{2})?$/.test(text)) return false;
    
    const value = parseFloat(text.replace(/,/g, ''));
    return value >= 0.01 && value <= 50000; // Reasonable transaction range
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

  groupTransactions(items: string[], startIndex: number, endIndex: number): Transaction[] {
    const transactions: Transaction[] = [];
    let currentDate = '';
    let i = startIndex;

    while (i < endIndex) {
      const item = items[i].trim();
      if (!item) { i++; continue; }

      // 1. Check for date - update current date context
      if (this.isDate(item)) {
        currentDate = item;
        i++;
        continue;
      }

      // 2. Check for transaction description
      if (this.isTransactionDescription(item)) {
        const transaction = this.parseTransaction(items, i, currentDate);
        if (transaction) {
          transactions.push(transaction);
          i = transaction.nextIndex;
        } else {
          i++;
        }
      } else {
        i++;
      }
    }

    return transactions;
  }

  // 6. Parse a single transaction starting from description
  parseTransaction(items: string[], startIndex: number, currentDate: string): (Transaction & { nextIndex: number }) | null {
    let description = items[startIndex];
    let i = startIndex + 1;

    // Check if next item is a reference code
    if (i < items.length && this.isReferenceCode(items[i], description)) {
      description += ` ${items[i]}`;
      i++;
    }

    // Look ahead for amounts - scan next few items
    let amount = 0;
    let balance: number | undefined;
    
    for (let j = i; j < Math.min(i + 5, items.length); j++) {
      const item = items[j];
      
      if (this.isAmount(item)) {
        const value = parseFloat(item.replace(/,/g, ''));
        
        if (this.isLikelyBalance(item)) {
          balance = value;
        } else if (amount === 0) { // First amount found
          amount = this.isDepositType(description) ? value : -value;
        }
      }
      
      // Stop if we hit another transaction or date
      if (this.isDate(item) || this.isTransactionDescription(item)) {
        break;
      }
    }

    if (amount === 0) return null; // No amount found

    return {
      date: currentDate,
      description,
      amount,
      type: amount > 0 ? 'deposit' : 'withdrawal',
      balance,
      rawLine: items.slice(startIndex, i).join(' | '),
      nextIndex: i
    };
  }

  // 7. Main parsing function
  async parseTransactions(file: File): Promise<Transaction[]> {
    const items = await this.extractAllTextItems(file);
    const startIndex = this.findTransactionStartIndex(items);
    const endIndex = this.findTransactionEndIndex(items, startIndex);
    
    if (startIndex === -1) {
      throw new Error('Could not find transaction start marker');
    }

    return this.groupTransactions(items, startIndex, endIndex);
  }

  async testPatterns(file: File): Promise<void> {
    const items = await this.extractAllTextItems(file);
    const startIndex = this.findTransactionStartIndex(items);
    const endIndex = this.findTransactionEndIndex(items, startIndex);
    
    console.log("\n=== ENHANCED PATTERN TESTING ===");
    console.log(`Transaction range: ${startIndex} to ${endIndex}`);
    
    let currentDate = '';
    let transactionCount = 0;
    
    // Test contextual parsing in transaction section only
    for (let i = startIndex; i < Math.min(endIndex, startIndex + 100); i++) {
      const item = items[i].trim();
      if (!item) continue;
      
      const prev = i > 0 ? items[i-1] : '';
      const next = i < items.length-1 ? items[i+1] : '';
      
      // Date detection
      if (this.isDate(item)) {
        currentDate = item;
        console.log(`\n📅 DATE: ${item}`);
        continue;
      }
      
      // Transaction detection with context
      if (this.isTransactionDescription(item)) {
        transactionCount++;
        console.log(`\n💳 TRANSACTION ${transactionCount} (${currentDate}): ${item}`);
        
        // Check for reference code
        if (this.isReferenceCode(next, item)) {
          console.log(`   📋 REF CODE: ${next}`);
        }
        
        // Look for amounts in next few items
        for (let j = i + 1; j < Math.min(i + 5, items.length); j++) {
          if (this.isAmount(items[j])) {
            const type = this.isLikelyBalance(items[j]) ? 'BALANCE' : 'AMOUNT';
            const sign = this.isDepositType(item) ? '+' : '-';
            console.log(`   💰 ${type}: ${sign}${items[j]}`);
          }
        }
      }
    }
    
    console.log(`\n📊 SUMMARY: Found ${transactionCount} transactions in first 100 items`);
    
    // Test full parsing
    try {
      const transactions = await this.parseTransactions(file);
      console.log(`\n✅ FULL PARSE: Successfully parsed ${transactions.length} transactions`);
      
      // Show first few transactions
      transactions.slice(0, 3).forEach((t, idx) => {
        console.log(`${idx + 1}. ${t.date} | ${t.description} | ${t.amount > 0 ? '+' : ''}${t.amount} | ${t.balance || 'N/A'}`);
      });
    } catch (error) {
      console.log(`❌ FULL PARSE FAILED: ${error}`);
    }
  }
}