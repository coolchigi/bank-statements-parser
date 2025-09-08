import React, { useState } from 'react';

const PDFUpload = () => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files && event.target.files[0];
    setSelectedFile(file);
  };

  const handleAction = async (action: string) => {
    if (!selectedFile) return;
    
    if (selectedFile.type !== 'application/pdf') {
      alert('Please select a PDF file');
      return;
    }

    setIsProcessing(true);
    
    try {
      console.log(`Processing PDF: ${selectedFile.name} - Action: ${action}`);
      
      const { RBCPdfParser } = await import('../lib/rbcPdfParser');
      const parser = new RBCPdfParser();
      
      if (action === 'extract') {
        await parser.extractText(selectedFile);
      } else if (action === 'patterns') {
        await parser.testPatterns(selectedFile);
      }
      
      console.log('Processing complete. Check console for output.');
    } catch (error) {
      console.error('Error processing PDF:', error);
      alert('Error processing PDF. Check console for details.');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="max-w-md mx-auto mt-8 p-6 bg-white rounded-lg shadow-lg">
      <h2 className="text-xl font-bold mb-4">RBC Statement Parser</h2>
      
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
        <button
          onClick={() => handleAction('extract')}
          disabled={!selectedFile || isProcessing}
          className="w-full py-2 px-4 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
        >
          Extract Raw Text
        </button>
        
        <button
          onClick={() => handleAction('patterns')}
          disabled={!selectedFile || isProcessing}
          className="w-full py-2 px-4 bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
        >
          Test Pattern Detection
        </button>
      </div>
      
      {isProcessing && (
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
          <p className="mt-2 text-sm text-gray-600">Processing PDF...</p>
        </div>
      )}
      
      <p className="text-xs text-gray-500 mt-2">
        Check your browser console for the output.
      </p>
    </div>
  );
};

export default PDFUpload;