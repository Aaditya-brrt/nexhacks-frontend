import { NextRequest, NextResponse } from 'next/server';
import { convertDicomToJson, storePixelData } from '@/lib/dicom-processor';

// Mock upload endpoint
// TODO: Replace with actual backend integration
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('files');

    // Generate a mock scan ID
    const scanId = `scan-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    console.log('[UPLOAD] Processing upload for scanId:', scanId, 'with', files.length, 'files');

    // Process DICOM files and convert to pixel JSON
    // In a real implementation, files would be uploaded to storage
    // and a processing job would be queued
    if (files.length > 0) {
      try {
        // Process the first file (or all files combined) to pixel JSON
        // For demo purposes, we'll process the first file
        const firstFile = files[0] as File;
        console.log('[UPLOAD] Processing file:', firstFile.name, 'size:', firstFile.size);
        
        // Always create pixel JSON data (for both DICOM and non-DICOM files)
        // In production, handle NIfTI, MHD, etc. formats
        const pixelData = await convertDicomToJson(firstFile);
        console.log('[UPLOAD] Pixel data generated (base64 PNG):', {
          base64Length: pixelData.base64Png.length,
          width: pixelData.width,
          height: pixelData.height,
          slices: pixelData.slices,
          modality: pixelData.modality
        });
        
        // Store pixel JSON data for later use in AI analysis
        storePixelData(scanId, pixelData);
        console.log('[UPLOAD] Pixel data stored for scanId:', scanId);
      } catch (conversionError) {
        // Log but don't fail upload if conversion has issues
        console.error('[UPLOAD] DICOM conversion error:', conversionError);
        // Still create mock pixel data as fallback
        try {
          const fallbackPixelData = await convertDicomToJson(files[0] as File);
          storePixelData(scanId, fallbackPixelData);
          console.log('[UPLOAD] Fallback pixel data stored for scanId:', scanId);
        } catch (fallbackError) {
          console.error('[UPLOAD] Fallback pixel data generation failed:', fallbackError);
        }
      }
    } else {
      console.warn('[UPLOAD] No files provided in upload request');
      // Still create placeholder pixel data even if no files
      const placeholderFile = new File([''], 'placeholder.dcm', { type: 'application/dicom' });
      const pixelData = await convertDicomToJson(placeholderFile);
      storePixelData(scanId, pixelData);
      console.log('[UPLOAD] Placeholder pixel data stored for scanId:', scanId);
    }

    return NextResponse.json({
      scanId,
      message: 'Upload successful. Processing started.',
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Upload failed', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
