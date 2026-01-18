'use client';

import { useEffect, useState, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { getStatus, getResults, analyzeScan, StatusResponse, ResultsResponse } from '@/lib/api';
import LoadingSpinner from '@/components/LoadingSpinner';
import ProgressBar from '@/components/ProgressBar';
import StatusBadge from '@/components/StatusBadge';
import ResultCard from '@/components/ResultCard';
import ErrorBanner from '@/components/ErrorBanner';

export default function ResultsPage() {
  const params = useParams();
  const router = useRouter();
  const scanId = params.scanId as string;

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [results, setResults] = useState<ResultsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [diagnosisStream, setDiagnosisStream] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState(false);
  const streamStartedRef = useRef(false);

  useEffect(() => {
    if (!scanId) {
      setError('Invalid scan ID');
      setIsLoading(false);
      return;
    }

    let isMounted = true;

    const pollStatus = async () => {
      try {
        const statusData = await getStatus(scanId);
        if (!isMounted) return;

        setStatus(statusData);
        setError(null);

        // Trigger AI analysis when stage reaches "analyzing"
        if (statusData.stage === 'analyzing' && !streamStartedRef.current) {
          streamStartedRef.current = true;
          startAiAnalysis(scanId);
        }

        // If completed, fetch results
        if (statusData.stage === 'completed' && !results) {
          try {
            const resultsData = await getResults(scanId);
            if (isMounted) {
              setResults(resultsData);
              setIsLoading(false);
            }
          } catch (err) {
            if (isMounted) {
              setError(
                err instanceof Error
                  ? err.message
                  : 'Failed to fetch results'
              );
              setIsLoading(false);
            }
          }
        }

        // If error, stop polling
        if (statusData.stage === 'error') {
          setIsLoading(false);
        }
      } catch (err) {
        if (isMounted) {
          setError(
            err instanceof Error
              ? err.message
              : 'Failed to fetch status'
          );
          setIsLoading(false);
        }
      }
    };

    // Initial status fetch
    pollStatus();

    // Poll every 2-3 seconds while processing
    const pollInterval = setInterval(() => {
      if (status?.stage === 'completed' || status?.stage === 'error') {
        clearInterval(pollInterval);
        return;
      }
      pollStatus();
    }, 2500);

    return () => {
      isMounted = false;
      if (pollInterval) {
        clearInterval(pollInterval);
      }
    };
  }, [scanId, results, status?.stage]);

  // Function to start AI analysis streaming
  const startAiAnalysis = async (scanId: string) => {
    try {
      setIsStreaming(true);
      setDiagnosisStream('');

      // Get the streaming response
      const response = await analyzeScan(scanId);

      if (!response.ok) {
        throw new Error(`AI analysis failed: ${response.statusText}`);
      }

      // Read the stream
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('Stream reader not available');
      }

      const decoder = new TextDecoder();
      let accumulatedText = '';

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        // Decode the chunk
        const chunk = decoder.decode(value, { stream: true });
        
        // Parse the AI SDK stream format
        // Format can be: "0:{"type":"text-delta","textDelta":"..."}" or plain text
        const lines = chunk.split('\n');
        
        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine) continue;
          
          // Try AI SDK format: "0:{"type":"text-delta","textDelta":"..."}"
          if (trimmedLine.startsWith('0:')) {
            try {
              const jsonStr = trimmedLine.substring(2); // Remove "0:" prefix
              const data = JSON.parse(jsonStr);
              
              if (data.type === 'text-delta' && data.textDelta) {
                accumulatedText += data.textDelta;
                setDiagnosisStream(accumulatedText);
              } else if (data.type === 'text' && data.text) {
                accumulatedText += data.text;
                setDiagnosisStream(accumulatedText);
              }
            } catch {
              // If JSON parsing fails, skip this line
              console.warn('Failed to parse AI SDK stream line:', trimmedLine);
            }
          } else if (trimmedLine.startsWith('data: ')) {
            // Handle SSE format (Server-Sent Events)
            try {
              const jsonStr = trimmedLine.substring(6); // Remove "data: " prefix
              const data = JSON.parse(jsonStr);
              if (data.textDelta || data.text) {
                accumulatedText += data.textDelta || data.text;
                setDiagnosisStream(accumulatedText);
              }
            } catch {
              // If not JSON, treat as plain text
              const text = trimmedLine.substring(6);
              if (text) {
                accumulatedText += text;
                setDiagnosisStream(accumulatedText);
              }
            }
          } else {
            // Plain text chunks - append directly
            accumulatedText += trimmedLine + ' ';
            setDiagnosisStream(accumulatedText);
          }
        }
      }

      // Store final diagnosis in results
      if (accumulatedText && !results) {
        // Create a results object with streamed diagnosis
        const streamedResults: ResultsResponse = {
          scanId,
          diagnosisSummary: accumulatedText,
          confidence: 0.85, // Default confidence for AI-generated
          keyFindings: extractKeyFindings(accumulatedText),
          compressedPreviewUrl: '/mock/compressed-image.png',
          metadata: {
            modality: 'MRI', // Would come from actual scan data
            slicesProcessed: 256,
            compressionRatio: 0.2,
          },
        };
        setResults(streamedResults);
      }

      setIsStreaming(false);
    } catch (err) {
      setIsStreaming(false);
      console.error('AI Analysis error:', err);
      setError(
        err instanceof Error
          ? `AI analysis failed: ${err.message}`
          : 'Failed to stream AI analysis'
      );
    }
  };

  // Helper function to extract key findings from diagnosis text
  const extractKeyFindings = (text: string): string[] => {
    // Simple extraction - look for bullet points, numbered lists, or key phrases
    const findings: string[] = [];
    
    // Extract bullet points
    const bulletMatches = text.match(/[•\-*]\s*(.+?)(?=\n|$)/g);
    if (bulletMatches) {
      findings.push(...bulletMatches.map(m => m.replace(/^[•\-*]\s*/, '').trim()).slice(0, 5));
    }
    
    // Extract numbered items
    const numberedMatches = text.match(/\d+\.\s*(.+?)(?=\n|$)/g);
    if (numberedMatches && findings.length < 5) {
      findings.push(...numberedMatches.map(m => m.replace(/^\d+\.\s*/, '').trim()).slice(0, 5 - findings.length));
    }
    
    // If no structured findings, extract key sentences
    if (findings.length === 0) {
      const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 20);
      findings.push(...sentences.slice(0, 4).map(s => s.trim()));
    }
    
    return findings.length > 0 ? findings : ['AI analysis completed'];
  };

  const handleRetry = () => {
    setError(null);
    setIsLoading(true);
    setStatus(null);
    setResults(null);
    // Trigger re-fetch by updating a dependency
    window.location.reload();
  };

  const formatTime = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-6">
          <button
            onClick={() => router.push('/')}
            className="text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 text-sm font-medium mb-4 inline-flex items-center gap-1"
          >
            ← Back to Upload
          </button>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
            Scan Analysis Results
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mt-2">
            Scan ID: <code className="font-mono text-sm bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">{scanId}</code>
          </p>
        </div>

        {error && (
          <ErrorBanner
            message={error}
            onRetry={handleRetry}
          />
        )}

        {isLoading && !status && (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8 text-center">
            <LoadingSpinner size="lg" label="Loading scan status..." />
          </div>
        )}

        {status && status.stage !== 'completed' && status.stage !== 'error' && (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8">
            <div className="flex flex-col items-center gap-6">
              <LoadingSpinner size="lg" />
              <div className="w-full max-w-md">
                <div className="flex justify-center mb-4">
                  <StatusBadge stage={status.stage} />
                </div>
                <ProgressBar
                  progress={status.progress}
                  label="Processing progress"
                  showPercentage={true}
                />
                {status.etaSeconds !== null && (
                  <p className="text-center text-sm text-gray-600 dark:text-gray-400 mt-4">
                    Estimated time remaining: {formatTime(status.etaSeconds)}
                  </p>
                )}
              </div>
              <div className="text-center text-sm text-gray-500 dark:text-gray-500">
                {status.stage === 'queued' && 'Your scan is queued for processing...'}
                {status.stage === 'normalizing' && 'Normalizing scan data for analysis...'}
                {status.stage === 'compressing' && 'Compressing scan data...'}
                {status.stage === 'analyzing' && 'Running AI analysis on scan data...'}
              </div>
            </div>
          </div>
        )}

        {/* Display streaming diagnosis during analyzing stage */}
        {status && status.stage === 'analyzing' && (diagnosisStream || isStreaming) && (
          <div className="mt-6 bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6 md:p-8">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                AI Diagnosis
              </h2>
              {isStreaming && (
                <span className="text-sm text-blue-600 dark:text-blue-400 flex items-center gap-2">
                  <span className="animate-pulse">●</span> Streaming...
                </span>
              )}
            </div>
            <div className="prose prose-sm max-w-none dark:prose-invert">
              <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
                {diagnosisStream ? (
                  <div className="text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
                    {diagnosisStream}
                    {isStreaming && (
                      <span className="inline-block w-2 h-4 bg-blue-600 dark:bg-blue-400 ml-1 animate-pulse" />
                    )}
                  </div>
                ) : (
                  <div className="text-gray-500 dark:text-gray-400">
                    <LoadingSpinner size="sm" label="Initializing AI analysis..." />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {status && status.stage === 'error' && (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-8">
            <div className="text-center">
              <StatusBadge stage="error" />
              {status.errorMessage && (
                <p className="mt-4 text-gray-700 dark:text-gray-300">
                  {status.errorMessage}
                </p>
              )}
              <button
                onClick={handleRetry}
                className="mt-6 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
              >
                Retry Processing
              </button>
            </div>
          </div>
        )}

        {results && (
          <div className="mt-6">
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6 md:p-8">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                  Analysis Complete
                </h2>
                <StatusBadge stage="completed" />
              </div>
              <ResultCard results={results} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
