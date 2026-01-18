// API Client for MRI/CT Scan Dashboard
// TODO: Replace with actual backend URL when backend is implemented
// const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

// Type definitions for API responses
export interface UploadResponse {
  scanId: string;
  message: string;
}

export type ProcessingStage = 
  | 'queued' 
  | 'normalizing' 
  | 'compressing' 
  | 'analyzing' 
  | 'completed' 
  | 'error';

export interface StatusResponse {
  scanId: string;
  stage: ProcessingStage;
  progress: number; // 0.0 to 1.0
  etaSeconds: number | null;
  errorMessage: string | null;
}

export interface ResultsResponse {
  scanId: string;
  diagnosisSummary: string;
  confidence: number; // 0.0 to 1.0
  keyFindings: string[];
  compressedPreviewUrl: string;
  metadata: {
    modality: 'MRI' | 'CT';
    slicesProcessed: number;
    compressionRatio: number;
  };
}

// In-memory state to track mock scan processing
const mockScanStates: Map<string, {
  startTime: number;
  stage: ProcessingStage;
  progress: number;
}> = new Map();

// Helper to generate random UUID
function generateScanId(): string {
  return `scan-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Helper to calculate mock progress - immediately jump to analyzing
function calculateMockProgress(scanId: string): { stage: ProcessingStage; progress: number } {
  const state = mockScanStates.get(scanId);
  if (!state) {
    return { stage: 'queued', progress: 0 };
  }

  // Immediately jump to analyzing stage - AI will stream response
  return { stage: 'analyzing', progress: 0.7 };
}

/**
 * Upload scan files to the backend
 * @param files - FileList or File[] to upload
 * @returns Promise with scanId and message
 */
export async function uploadScan(files: FileList | File[]): Promise<UploadResponse> {
  // Call the upload API route to process files and generate pixel JSON
  const formData = new FormData();
  Array.from(files).forEach((file) => {
    formData.append('files', file);
  });
  
  const response = await fetch('/api/upload', {
    method: 'POST',
    body: formData,
  });
  
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || errorData.error || 'Upload failed');
  }
  
  const result = await response.json();
  
  // Also update mock scan states for status tracking
  if (result.scanId) {
    mockScanStates.set(result.scanId, {
      startTime: Date.now(),
      stage: 'queued',
      progress: 0,
    });
  }
  
  return result;
}

/**
 * Get the current processing status for a scan
 * @param scanId - The scan ID to check status for
 * @returns Promise with current status
 */
export async function getStatus(scanId: string): Promise<StatusResponse> {
  // TODO: Replace with actual API call
  // const response = await fetch(`${API_BASE_URL}/api/status?scanId=${scanId}`);
  // if (!response.ok) throw new Error('Failed to fetch status');
  // return response.json();

  // Mock implementation
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const state = mockScanStates.get(scanId);
      if (!state) {
        reject(new Error('Scan not found'));
        return;
      }

      // Simulate error for specific scan IDs (for testing)
      if (scanId.includes('error')) {
        resolve({
          scanId,
          stage: 'error',
          progress: 0.5,
          etaSeconds: null,
          errorMessage: 'Processing failed: Unable to analyze scan data.',
        });
        return;
      }

      const { stage, progress } = calculateMockProgress(scanId);

      // Update stored state
      state.stage = stage;
      state.progress = progress;

      resolve({
        scanId,
        stage,
        progress,
        etaSeconds: null, // No ETA for streaming AI
        errorMessage: null,
      });
    }, 300);
  });
}

/**
 * Get the final results for a completed scan
 * @param scanId - The scan ID to get results for
 * @returns Promise with diagnostic results
 */
export async function getResults(scanId: string): Promise<ResultsResponse> {
  // TODO: Replace with actual API call
  // const response = await fetch(`${API_BASE_URL}/api/results?scanId=${scanId}`);
  // if (!response.ok) throw new Error('Failed to fetch results');
  // return response.json();

  // Mock implementation
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      const state = mockScanStates.get(scanId);
      if (!state) {
        reject(new Error('Scan not found'));
        return;
      }

      // Generate mock diagnostic results
      const mockDiagnoses = [
        {
          summary: 'No significant abnormalities detected. Brain structures appear normal with no evidence of mass effect, hemorrhage, or acute infarction. Ventricular system is within normal limits.',
          confidence: 0.92,
          findings: [
            'Normal brain parenchyma',
            'No mass lesions identified',
            'Ventricular system normal',
            'No evidence of acute pathology',
          ],
        },
        {
          summary: 'Mild cerebral atrophy noted with slight prominence of the sulci and ventricles. No acute intracranial abnormality. Small chronic lacunar infarct in the left basal ganglia region.',
          confidence: 0.87,
          findings: [
            'Mild age-related cerebral atrophy',
            'Chronic lacunar infarct in left basal ganglia',
            'No acute hemorrhage or mass effect',
            'Ventricular prominence within normal limits',
          ],
        },
        {
          summary: 'Focal area of increased T2 signal in the periventricular white matter, consistent with demyelinating changes. No mass effect or enhancement. Recommend clinical correlation.',
          confidence: 0.79,
          findings: [
            'Periventricular white matter hyperintensities',
            'Possible demyelinating process',
            'No mass effect',
            'Clinical correlation recommended',
          ],
        },
      ];

      const diagnosis = mockDiagnoses[Math.floor(Math.random() * mockDiagnoses.length)];
      const modality: 'MRI' | 'CT' = Math.random() > 0.5 ? 'MRI' : 'CT';

      resolve({
        scanId,
        diagnosisSummary: diagnosis.summary,
        confidence: diagnosis.confidence,
        keyFindings: diagnosis.findings,
        compressedPreviewUrl: '/mock/compressed-image.png', // Placeholder image
        metadata: {
          modality,
          slicesProcessed: modality === 'MRI' ? 256 : 512,
          compressionRatio: 0.15 + Math.random() * 0.1, // 15-25% compression
        },
      });
    }, 500);
  });
}

/**
 * Trigger AI analysis for a scan and return a stream
 * @param scanId - The scan ID to analyze
 * @returns Promise with ReadableStream for streaming diagnosis
 */
export async function analyzeScan(scanId: string): Promise<Response> {
  // TODO: Replace with actual API call
  // const response = await fetch(`${API_BASE_URL}/api/analyze`, {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json' },
  //   body: JSON.stringify({ scanId }),
  // });
  // return response;

  // Call the streaming API endpoint
  const response = await fetch('/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scanId }),
  });

  if (!response.ok) {
    throw new Error(`AI analysis failed: ${response.statusText}`);
  }

  return response;
}
