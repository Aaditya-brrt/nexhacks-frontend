// DICOM Processing - Flask API Integration
// Interfaces match Flask API response structure

export interface FlaskLLMPayload {
  prompt: string;
  estimated_tokens: number;
  base_image_base64: string; // Base64-encoded PNG image
  delta_images?: Array<{
    image_base64: string;
    slice_index?: number;
    description?: string;
  }>;
  base_image_format: string; // Usually 'png'
}

export interface FlaskMetadata {
  num_slices: number;
  num_deltas_included: number;
  processed_at: string;
}

export interface FlaskAPIResponse {
  llm_payload: FlaskLLMPayload;
  metadata: FlaskMetadata;
  claude_query?: any; // Optional formatted query
  openai_query?: any; // Optional formatted query
}

// Store structure for processed scan data
export interface PixelDataJson {
  base64Png: string; // Base64-encoded PNG image (from llm_payload.base_image_base64)
  slices: number; // Number of slices (from metadata.num_slices)
  modality: 'MRI' | 'CT'; // Inferred or from metadata
  prompt?: string; // Optional prompt from Flask
  metadata: FlaskMetadata;
}

// In-memory storage for pixel JSON data
// TODO: Replace with database or file storage for production
const pixelDataStore: Map<string, PixelDataJson> = new Map();

/**
 * Get all stored scan IDs (for debugging)
 * @returns Array of scan IDs that have pixel data stored
 */
export function getAllStoredScanIds(): string[] {
  return Array.from(pixelDataStore.keys());
}

/**
 * @deprecated This function is no longer used - DICOM processing is handled by Flask API
 * Convert a DICOM file to pixel JSON format
 * @param file - The DICOM file to process
 * @returns Promise with pixel JSON data
 */
export async function convertDicomToJson(file: File): Promise<PixelDataJson> {
  // TODO: Replace with real DICOM parser
  // Example with dicom-parser library:
  // const arrayBuffer = await file.arrayBuffer();
  // const byteArray = new Uint8Array(arrayBuffer);
  // const dataset = dicomParser.parseDicom(byteArray);
  // const pixelData = dataset.elements.x7fe00010; // Pixel Data element
  // const width = dataset.uint16('x00280011'); // Columns
  // const height = dataset.uint16('x00280010'); // Rows
  
  // Placeholder implementation - generates mock pixel data and converts to base64 PNG
  const fileSize = file.size;
  
  // Generate placeholder pixel data based on file size
  // Typical DICOM image dimensions: 512x512 or 256x256
  const width = 512;
  const height = 512;
  const slices = Math.max(1, Math.min(10, Math.floor(fileSize / (width * height * 2)))); // Limit slices for faster generation
  
  // Determine modality based on filename or default to MRI
  const modality: 'MRI' | 'CT' = 
    file.name.toLowerCase().includes('ct') ? 'CT' : 'MRI';
  
  // Generate pixel data for a representative slice (grayscale values 0-255 for PNG)
  const pixelsPerSlice = width * height;
  const pixelBuffer = Buffer.alloc(pixelsPerSlice);
  
  // Create a pattern that simulates medical image data
  const baseValue = 128; // Mid-range grayscale for PNG (0-255)
  for (let i = 0; i < pixelsPerSlice; i++) {
    const x = i % width;
    const y = Math.floor(i / width);
    
    // Create a pattern that looks vaguely medical (centered with variations)
    const centerX = width / 2;
    const centerY = height / 2;
    const distance = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);
    const variation = Math.sin(distance / 50) * 50 + Math.random() * 30;
    const pixelValue = Math.max(0, Math.min(255, Math.floor(baseValue + variation)));
    pixelBuffer[i] = pixelValue;
  }
  
  // Convert pixel buffer to PNG using sharp
  const pngBuffer = await sharp(pixelBuffer, {
    raw: {
      width,
      height,
      channels: 1, // Grayscale
    },
  })
    .png()
    .toBuffer();
  
  // Convert PNG buffer to base64 string
  const base64Png = pngBuffer.toString('base64');
  
  const pixelData: PixelDataJson = {
    base64Png,
    width,
    height,
    slices,
    modality,
    metadata: {
      seriesInstanceUID: `1.2.840.${Date.now()}`,
      studyInstanceUID: `1.2.840.${Date.now() - 1000000}`,
      patientId: `PAT${Math.floor(Math.random() * 10000)}`,
      studyDate: new Date().toISOString().split('T')[0],
      studyTime: new Date().toTimeString().split(' ')[0],
    },
  };
  
  return pixelData;
}

/**
 * Store pixel JSON data for a scan
 * @param scanId - The scan ID
 * @param pixelData - The pixel JSON data
 */
export function storePixelData(scanId: string, pixelData: PixelDataJson): void {
  pixelDataStore.set(scanId, pixelData);
}

/**
 * Retrieve pixel JSON data for a scan
 * @param scanId - The scan ID
 * @returns The pixel JSON data or null if not found
 */
export function getPixelData(scanId: string): PixelDataJson | null {
  return pixelDataStore.get(scanId) || null;
}

/**
 * Remove pixel JSON data for a scan (cleanup)
 * @param scanId - The scan ID
 */
export function removePixelData(scanId: string): void {
  pixelDataStore.delete(scanId);
}
