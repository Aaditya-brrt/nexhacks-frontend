// API Client for MRI/CT Scan Dashboard
import { getJobResult, getBundleMetadata, getBundleFileAsBase64 } from '@/lib/fastapi-client';
import { storePixelData } from '@/lib/dicom-processor';

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

// These are kept for backward compatibility but not used with FastAPI
// Helper to generate random UUID (deprecated - FastAPI generates job_id)
// function generateScanId(): string {
//   return `scan-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
// }

// Helper to calculate mock progress (deprecated - FastAPI handles status)
// function calculateMockProgress(scanId: string): { stage: ProcessingStage; progress: number } {
//   const state = mockScanStates.get(scanId);
//   if (!state) {
//     return { stage: 'queued', progress: 0 };
//   }
//   return { stage: 'analyzing', progress: 0.7 };
// }

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
 * Get the current processing status for a scan (job_id from FastAPI)
 * @param scanId - The job ID (used as scanId for compatibility)
 * @returns Promise with current status
 */
export async function getStatus(scanId: string): Promise<StatusResponse> {
  try {
    // Call FastAPI /result/{job_id} endpoint
    const jobResult = await getJobResult(scanId);
    
    console.log('[API] getStatus - Job result:', {
      scanId,
      status: jobResult.status,
      error: jobResult.error,
    });
    
    // Map FastAPI status to our ProcessingStage
    let stage: ProcessingStage;
    let progress = 0.5;
    
    switch (jobResult.status) {
      case 'pending':
        stage = 'queued';
        progress = 0.1;
        break;
      case 'processing':
        stage = 'compressing'; // FastAPI compresses in processing stage
        progress = 0.5;
        break;
      case 'complete':
        // When complete, we need to fetch bundle and store it BEFORE setting to analyzing
        // Check if pixel data is already stored
        const { getPixelData } = await import('@/lib/dicom-processor');
        const existingData = getPixelData(scanId);
        
        if (existingData) {
          // Already stored - ready for AI analysis
          stage = 'analyzing';
          progress = 0.8;
        } else {
          // Try to fetch bundle and store it
          try {
            const bundleMeta = await getBundleMetadata(scanId);
            // FastAPI backend creates montage_overview.png as the main representative image
            // The metadata.bundle.montage_file contains "montage_overview.png"
            // Fallback to first PNG file if montage doesn't exist
            let baseImageFile = 'montage_overview.png'; // Default
            
            // Try to get from metadata.bundle.montage_file
            if (bundleMeta.metadata?.bundle && typeof bundleMeta.metadata.bundle === 'object') {
              const bundle = bundleMeta.metadata.bundle as { montage_file?: string };
              if (bundle.montage_file) {
                baseImageFile = bundle.montage_file;
              }
            }
            
            // Verify file exists in bundle, otherwise find any PNG
            if (!bundleMeta.files.includes(baseImageFile)) {
              baseImageFile = bundleMeta.files.find(f => f.endsWith('.png')) || 'montage_overview.png';
            }
            
            // Fetch base image and store it for AI analysis
            const base64Png = await getBundleFileAsBase64(scanId, baseImageFile);
            const numSlices = typeof jobResult.metrics?.num_slices === 'number' 
              ? jobResult.metrics.num_slices 
              : 0;
            const pixelData = {
              base64Png,
              slices: numSlices,
              modality: 'CT' as const,
              prompt: (typeof bundleMeta.metadata.prompt === 'string' ? bundleMeta.metadata.prompt : null) || 'Please analyze this CT scan series.',
              metadata: {
                num_slices: numSlices,
                num_deltas_included: 0,
                processed_at: jobResult.completed_at || new Date().toISOString(),
              },
            };
            storePixelData(scanId, pixelData);
            console.log('[API] Bundle data stored for AI analysis:', scanId);
            // Now ready for AI analysis
            stage = 'analyzing';
            progress = 0.8;
          } catch (bundleError) {
            console.warn('[API] Bundle not ready yet, keeping as compressing:', bundleError);
            // Keep as compressing until bundle is ready
            stage = 'compressing';
            progress = 0.7;
          }
        }
        break;
      case 'failed':
        stage = 'error';
        progress = 0;
        break;
      default:
        stage = 'queued';
        progress = 0;
    }
    
    return {
      scanId,
      stage,
      progress,
      etaSeconds: null,
      errorMessage: jobResult.error || null,
    };
  } catch (error) {
    // If job not found, treat as error
    if (error instanceof Error && error.message.includes('404')) {
      return {
        scanId,
        stage: 'error',
        progress: 0,
        etaSeconds: null,
        errorMessage: 'Job not found',
      };
    }
    
    // Re-throw other errors
    throw error;
  }
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
