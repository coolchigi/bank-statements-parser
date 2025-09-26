import * as pdfjsLib from 'pdfjs-dist';

import pdfjsWorkerURL from 'pdfjs-dist/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerURL;

export interface Transaction {
  date: string;
  description: string;
  amount: number; // Positive = deposit, Negative = withdrawal
  balance?: number;
}

export class RBCPdfParser {

    async parseStatement(file: File): Promise<Transaction[]> {
    const lines = await this.extractLines(file);
    const transactionLines = this.getTransactionLines(lines);
    return this.parseTransactions(transactionLines);
  }
  
  private async extractLines(file: File): Promise<string[]> {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
    const allLines: string[] = [];
    
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      
      const lineGroups = new Map<number, any[]>();
      textContent.items.forEach((item: any) => {
        if (item.str.trim()) {
          const y = Math.round(item.transform[5]);
          if (!lineGroups.has(y)) lineGroups.set(y, []);
          lineGroups.get(y)!.push(item);
        }
      });
      
      const sortedLines = Array.from(lineGroups.entries())
        .sort((a, b) => b[0] - a[0])
        .map(([y, items]) => 
          items.sort((a, b) => a.transform[4] - b.transform[4])
               .map(item => item.str).join(' ').trim()
        );
      
      allLines.push(...sortedLines);
    }
    
    return allLines.filter(line => line.length > 0);
  }
  
  private getTransactionLines(lines: string[]): string[] {
    const start = lines.findIndex(line => line.includes('Details of your account activity'));
    const end = lines.findIndex((line, i) => i > start && line.includes('Closing Balance'));
    return lines.slice(start + 1, end).filter(line => 
      !line.includes('Date Description') && 
      !line.includes('continued') &&
      !line.match(/^\d+ of \d+$/) &&
      !line.includes('RBPDA')
    );
  }
  
  private parseTransactions(lines: string[]): Transaction[] {
    const transactions: Transaction[] = [];
    let currentDate = '';
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Check if line starts with date
      const dateMatch = line.match(/^(\d{1,2} \w{3})/);
      if (dateMatch) {
        currentDate = dateMatch[1];
      }
      
      // Extract amounts from line
      const amounts = line.match(/\b\d{1,3}(?:,\d{3})*\.\d{2}\b/g);
      
      // Get description (everything except the last 1-2 amounts)
      let description = line.replace(/\b\d{1,3}(?:,\d{3})*\.\d{2}\b/g, '').trim();
      if (dateMatch) {
        description = description.replace(/^\d{1,2} \w{3}/, '').trim();
      }
      
      // Determine transaction amount and balance
      if (!amounts) continue;
      const nums = amounts.map(a => parseFloat(a.replace(/,/g, '')));
      const amount = nums[nums.length - (nums.length > 1 ? 2 : 1)];
      const balance = nums.length > 1 ? nums[nums.length - 1] : undefined;
      
      // Check next line for continuation (if current line has no amounts)
      if (!amounts && i < lines.length - 1) {
        const nextLine = lines[i + 1];
        const nextAmounts = nextLine.match(/\b\d{1,3}(?:,\d{3})*\.\d{2}\b/g);
        if (nextAmounts && !nextLine.match(/^\d{1,2} \w{3}/)) {
          // Combine with next line
          description += ' ' + nextLine.replace(/\b\d{1,3}(?:,\d{3})*\.\d{2}\b/g, '').trim();
          const nums = nextAmounts.map(a => parseFloat(a.replace(/,/g, '')));
          const amount = nums[nums.length - (nums.length > 1 ? 2 : 1)];
          const balance = nums.length > 1 ? nums[nums.length - 1] : undefined;
          
          // Determine if amount is positive or negative
          const isDeposit = /received|deposit|payroll|refund|reversal|foreign exchange|ref \w+/i.test(description);
          const finalAmount = isDeposit ? Math.abs(amount) : -Math.abs(amount);
          
          transactions.push({
            date: currentDate,
            description: description,
            amount: finalAmount,
            balance: balance
          });
          
          i++; // Skip next line since we processed it
          continue;
        }
      }
      
      // Determine if amount is positive or negative
      const isDeposit = /received|deposit|payroll|refund|reversal|foreign exchange|ref \w+/i.test(description);
      const finalAmount = isDeposit ? Math.abs(amount) : -Math.abs(amount);
      
      transactions.push({
        date: currentDate,
        description: description,
        amount: finalAmount,
        balance: balance
      });
    }
    
    return transactions;
  }

}
