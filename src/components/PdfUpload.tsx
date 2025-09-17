import React, { useState } from 'react';
import type { Transaction } from '../lib/rbcPdfParser';

const PDFUpload = () => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [error, setError] = useState<string>('');

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files && event.target.files[0];
    setSelectedFile(file);
    setTransactions([]); // Clear previous results
    setError('');
  };

  const handleAction = async (action: string) => {
    if (!selectedFile) return;
    
    if (selectedFile.type !== 'application/pdf') {
      setError('Please select a PDF file');
      return;
    }

    setIsProcessing(true);
    setError('');
    
    try {
      console.log(`Processing PDF: ${selectedFile.name} - Action: ${action}`);
      
      const { RBCPdfParser } = await import('../lib/rbcPdfParser');
      const parser = new RBCPdfParser();
      
      if (action === 'extract') {
        await parser.extractText(selectedFile);
        console.log('Raw text extraction complete. Check console for output.');
      } else if (action === 'patterns') {
        await parser.testPatterns(selectedFile);
        console.log('Pattern testing complete. Check console for detailed output.');
      } else if (action === 'parse') {
        const parsedTransactions = await parser.parseTransactions(selectedFile);
        setTransactions(parsedTransactions);
        console.log(`Successfully parsed ${parsedTransactions.length} transactions`);
      }
      
    } catch (error) {
      console.error('Error processing PDF:', error);
      setError(`Error processing PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const formatAmount = (amount: number) => {
    const absAmount = Math.abs(amount);
    const formatted = absAmount.toLocaleString('en-CA', { 
      minimumFractionDigits: 2, 
      maximumFractionDigits: 2 
    });
    return amount >= 0 ? `+$${formatted}` : `-$${formatted}`;
  };

  const formatBalance = (balance?: number) => {
    if (balance === undefined) return 'N/A';
    return `$${balance.toLocaleString('en-CA', { 
      minimumFractionDigits: 2, 
      maximumFractionDigits: 2 
    })}`;
  };

  return (
    <div className="max-w-6xl mx-auto mt-8 p-6 bg-white">
      <div className="bg-white rounded-lg shadow-lg p-6 mb-6">
        <h2 className="text-2xl font-bold mb-4">RBC Statement Parser</h2>
        
        <div className="mb-4">
          <label 
            htmlFor="pdf-upload" 
            className="block text-sm font-medium text-gray-700 mb-2"
          >
            Upload RBC PDF Statement
          </label>
          
          <input
            id="pdf-upload"
            type="file"
            accept=".pdf"
            onChange={handleFileChange}
            disabled={isProcessing}
            className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 disabled:opacity-50"
          />
        </div>
        
        <div className="mb-4 space-y-2">
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={() => handleAction('extract')}
              disabled={!selectedFile || isProcessing}
              className="py-2 px-4 bg-gray-600 text-white rounded-md hover:bg-gray-700 disabled:opacity-50"
            >
              Extract Raw Text
            </button>
            
            <button
              onClick={() => handleAction('patterns')}
              disabled={!selectedFile || isProcessing}
              className="py-2 px-4 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              Test Patterns
            </button>
            
            <button
              onClick={() => handleAction('parse')}
              disabled={!selectedFile || isProcessing}
              className="py-2 px-4 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
            >
              Parse Transactions
            </button>
          </div>
        </div>
        
        {isProcessing && (
          <div className="text-center">
            <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
            <p className="mt-2 text-sm text-gray-600">Processing PDF...</p>
          </div>
        )}
        
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-4 mb-4">
            <p className="text-red-700">{error}</p>
          </div>
        )}
        
        <p className="text-xs text-gray-500 mt-2">
          Use "Test Patterns" to debug parsing accuracy. Check browser console for detailed output.
        </p>
      </div>

      {/* Transaction Verification Table */}
      {transactions.length > 0 && (
        <div className="bg-white rounded-lg shadow-lg overflow-hidden">
          <div className="px-6 py-4 bg-gray-50 border-b">
            <h3 className="text-lg font-semibold text-gray-900">
              Parsed Transactions ({transactions.length})
            </h3>
            <p className="text-sm text-gray-600 mt-1">
              Verify the parsing accuracy below. Green = deposits, Red = withdrawals.
            </p>
          </div>
          
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Date
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Description
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Amount
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Balance
                  </th>
                  <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Type
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {transactions.map((transaction, index) => (
                  <tr 
                    key={index} 
                    className={index % 2 === 0 ? 'bg-white' : 'bg-gray-50'}
                  >
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {transaction.date}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-900 max-w-md">
                      <div className="break-words">
                        {transaction.description}
                      </div>
                    </td>
                    <td className={`px-6 py-4 whitespace-nowrap text-sm font-medium text-right ${
                      transaction.amount >= 0 ? 'text-green-600' : 'text-red-600'
                    }`}>
                      {formatAmount(transaction.amount)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
                      {formatBalance(transaction.balance)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-center">
                      <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                        transaction.type === 'deposit' 
                          ? 'bg-green-100 text-green-800' 
                          : 'bg-red-100 text-red-800'
                      }`}>
                        {transaction.type}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          
          {/* Summary */}
          <div className="px-6 py-4 bg-gray-50 border-t">
            <div className="flex justify-between text-sm text-gray-600">
              <span>Total Transactions: {transactions.length}</span>
              <span>
                Deposits: {transactions.filter(t => t.type === 'deposit').length} | 
                Withdrawals: {transactions.filter(t => t.type === 'withdrawal').length}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PDFUpload;