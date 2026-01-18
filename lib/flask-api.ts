// Flask API Client
// Handles communication with the Flask backend API

const FLASK_API_URL = process.env.NEXT_PUBLIC_FLASK_API_URL || 'https://meghann-lightfast-lucille.ngrok-free.dev/';

/**
 * Test Flask API connection (for debugging)
 */
export async function testFlaskConnection(): Promise<{ success: boolean; message: string }> {
  try {
    const response = await fetch(`${FLASK_API_URL}/health`, {
      method: 'GET',
      headers: {
        'ngrok-skip-browser-warning': 'true',
      },
    });
    
    if (response.ok) {
      await response.json().catch(() => ({})); // Consume response
      return { success: true, message: 'Flask API is reachable' };
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

export interface FlaskCompressResponse {
  llm_payload: {
    prompt: string;
    estimated_tokens: number;
    base_image_base64: string;
    delta_images?: Array<{
      image_base64: string;
      slice_index?: number;
      description?: string;
    }>;
    base_image_format: string;
  };
  metadata: {
    num_slices: number;
    num_deltas_included: number;
    processed_at: string;
  };
  claude_query?: Record<string, unknown>;
  openai_query?: Record<string, unknown>;
}

/**
 * Call Flask /compress-dicom endpoint
 * @param zipFile - ZIP file containing DICOM files
 * @param options - Optional parameters for compression
 */
export async function compressDicomWithFlask(
  zipFile: File,
  options?: {
    clinicalQuestion?: string;
    includeDeltas?: boolean;
    numDeltas?: number;
  }
): Promise<FlaskCompressResponse> {
  // Create FormData for Flask API
  const formData = new FormData();
  
  // Flask expects a ZIP file as 'dicom_folder'
  formData.append('dicom_folder', zipFile);
  
  if (options?.clinicalQuestion) {
    formData.append('clinical_question', options.clinicalQuestion);
  }
  
  if (options?.includeDeltas !== undefined) {
    formData.append('include_deltas', options.includeDeltas.toString());
  }
  
  if (options?.numDeltas !== undefined) {
    formData.append('num_deltas', options.numDeltas.toString());
  }
  
  // Call Flask API
  // Note: ngrok free tier shows a browser warning page - header must be set correctly
  // The ngrok-skip-browser-warning header bypasses the warning page
  const response = await fetch(`${FLASK_API_URL}/compress-dicom`, {
    method: 'POST',
    body: formData,
    headers: {
      'ngrok-skip-browser-warning': 'true',
      'User-Agent': 'Next.js/16.1.3',
    },
    // Don't set Content-Type - FormData will set it with boundary automatically
  });
  
  if (!response.ok) {
    // Try to get error details
    const responseText = await response.text();
    let errorData: { error?: string; message?: string } = {};
    
    // Check if response is ngrok warning page HTML
    if (responseText.includes('ngrok') || responseText.includes('browser warning')) {
      console.error('[FLASK-API] ngrok browser warning page detected. Response might be HTML.');
      errorData = { 
        error: 'ngrok browser warning page detected. The API might require authentication or the URL might be incorrect.' 
      };
    } else {
      try {
        errorData = JSON.parse(responseText) as { error?: string; message?: string };
      } catch {
        // If not JSON, use the text as error message
        errorData = { error: responseText.substring(0, 200) || response.statusText };
      }
    }
    
    console.error('[FLASK-API] Error response details:', {
      status: response.status,
      statusText: response.statusText,
      url: `${FLASK_API_URL}/compress-dicom`,
      responseHeaders: Object.fromEntries(response.headers.entries()),
      responseBodyPreview: responseText.substring(0, 1000), // First 1000 chars
      isHtml: responseText.trim().startsWith('<'),
    });
    
    throw new Error(errorData.error || errorData.message || `Flask API error: ${response.status} ${response.statusText}`);
  }
  
  return response.json();
}
