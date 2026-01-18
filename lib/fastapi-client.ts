// FastAPI Client
// Handles communication with the FastAPI backend API

// Normalize URL - remove trailing slash if present to avoid double slashes
const FASTAPI_URL = (process.env.NEXT_PUBLIC_FASTAPI_URL || process.env.NEXT_PUBLIC_FLASK_API_URL || 'https://meghann-lightfast-lucille.ngrok-free.dev').replace(/\/+$/, '');
export interface JobResponse {
  job_id: string;
  status: 'pending' | 'processing' | 'complete' | 'failed';
  message?: string;
}

export interface JobResult {
  status: 'pending' | 'processing' | 'complete' | 'failed';
  patient_id?: string;
  metrics?: {
    compression_ratio?: number;
    [key: string]: unknown;
  };
  compressed_path?: string;
  llm_bundle_path?: string;
  error?: string;
  created_at?: string;
  completed_at?: string;
}

export interface BundleMetadata {
  job_id: string;
  bundle_path: string;
  files: string[];
  metadata: {
    base_image_file?: string;
    prompt?: string;
    [key: string]: unknown;
  };
}

/**
 * Test FastAPI connection (for debugging)
 */
export async function testFastApiConnection(): Promise<{ success: boolean; message: string }> {
  try {
    const response = await fetch(`${FASTAPI_URL}/health`, {
      method: 'GET',
      headers: {
        'ngrok-skip-browser-warning': '1', // ngrok expects '1', not 'true'
      },
    });
    
    if (response.ok) {
      await response.json().catch(() => ({})); // Consume response
      return { success: true, message: 'FastAPI is reachable' };
    }
    
    return { 
      success: false, 
      message: `Health check failed: ${response.status} ${response.statusText}` 
    };
  } catch (error) {
    return { 
      success: false, 
      message: `Health check error: ${error instanceof Error ? error.message : 'Unknown error'}` 
    };
  }
}

/**
 * Upload ZIP file and start compression job
 * @param zipFile - ZIP file containing DICOM files
 * @param generateLlmBundle - Whether to generate LLM bundle (default: true)
 */
export async function uploadAndCompress(
  zipFile: File,
  generateLlmBundle: boolean = true
): Promise<JobResponse> {
  // Create FormData for FastAPI
  const formData = new FormData();
  
  // FastAPI expects the file as 'file'
  formData.append('file', zipFile);
  
  // FastAPI accepts generate_llm_bundle as form field or query param
  // We'll send it as a form field
  formData.append('generate_llm_bundle', generateLlmBundle.toString());
  
  const response = await fetch(`${FASTAPI_URL}/compress/upload`, {
    method: 'POST',
    body: formData,
    headers: {
      'ngrok-skip-browser-warning': '1', // ngrok expects '1', not 'true'
      'User-Agent': 'Mozilla/5.0 (compatible; Next.js/16.1.3)',
    },
  });
  
  if (!response.ok) {
    const responseText = await response.text();
    let errorData: { error?: string; detail?: string; message?: string } = {};
    
    if (responseText.includes('ngrok') || responseText.includes('browser warning')) {
      console.error('[FASTAPI] ngrok browser warning page detected.');
      errorData = { 
        error: 'ngrok browser warning page detected. The API might require authentication or the URL might be incorrect.' 
      };
    } else {
      try {
        errorData = JSON.parse(responseText) as { error?: string; detail?: string; message?: string };
      } catch {
        errorData = { error: responseText.substring(0, 200) || response.statusText };
      }
    }
    
    console.error('[FASTAPI] Error response details:', {
      status: response.status,
      statusText: response.statusText,
      url: `${FASTAPI_URL}/compress/upload`,
      responseHeaders: Object.fromEntries(response.headers.entries()),
      responseBodyPreview: responseText.substring(0, 1000),
      isHtml: responseText.trim().startsWith('<'),
    });
    
    throw new Error(errorData.detail || errorData.error || errorData.message || `FastAPI error: ${response.status} ${response.statusText}`);
  }
  
  return response.json();
}

/**
 * Get job status and results
 * @param jobId - The job ID from upload
 */
export async function getJobResult(jobId: string): Promise<JobResult> {
  const response = await fetch(`${FASTAPI_URL}/result/${jobId}`, {
    method: 'GET',
    headers: {
      'ngrok-skip-browser-warning': '1', // ngrok expects '1', not 'true'
    },
  });
  
  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Failed to get job result: ${response.status} ${errorText}`);
  }
  
  return response.json();
}

/**
 * Get bundle metadata
 * @param jobId - The job ID
 */
export async function getBundleMetadata(jobId: string): Promise<BundleMetadata> {
  const response = await fetch(`${FASTAPI_URL}/bundle/${jobId}`, {
    method: 'GET',
    headers: {
      'ngrok-skip-browser-warning': '1', // ngrok expects '1', not 'true'
    },
  });
  
  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Failed to get bundle: ${response.status} ${errorText}`);
  }
  
  return response.json();
}

/**
 * Get a file from the bundle as base64
 * @param jobId - The job ID
 * @param filename - The filename to fetch (e.g., 'base_image.png')
 */
export async function getBundleFileAsBase64(jobId: string, filename: string): Promise<string> {
  const response = await fetch(`${FASTAPI_URL}/bundle/${jobId}/${filename}`, {
    method: 'GET',
    headers: {
      'ngrok-skip-browser-warning': '1', // ngrok expects '1', not 'true'
    },
  });
  
  if (!response.ok) {
    throw new Error(`Failed to get bundle file ${filename}: ${response.status}`);
  }
  
  // Get as blob, then convert to base64
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result as string;
      // Remove data URL prefix (e.g., "data:image/png;base64,")
      const base64Data = base64.split(',')[1] || base64;
      resolve(base64Data);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
