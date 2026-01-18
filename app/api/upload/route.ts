import { NextRequest, NextResponse } from 'next/server';
import archiver from 'archiver';
import { uploadAndCompress } from '@/lib/fastapi-client';

// Note: This is only used for logging. Actual API calls use fastapi-client.ts
const FASTAPI_URL = (process.env.NEXT_PUBLIC_FASTAPI_URL || process.env.NEXT_PUBLIC_FLASK_API_URL || "https://meghann-lightfast-lucille.ngrok-free.dev").replace(/\/+$/, '');

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('files');

    if (files.length === 0) {
      return NextResponse.json(
        { error: 'No files provided' },
        { status: 400 }
      );
    }

    // Determine if user uploaded a ZIP file or individual files
    let zipFile: File;
    const fileList = files as File[];
    
    // Check if single file is a ZIP
    if (fileList.length === 1 && (
      fileList[0].name.toLowerCase().endsWith('.zip') ||
      fileList[0].type === 'application/zip'
    )) {
      // User uploaded a ZIP file - use it directly
      console.log('[UPLOAD] Single ZIP file detected:', fileList[0].name);
      zipFile = fileList[0];
    } else {
      // User uploaded multiple individual files - create ZIP from them
      console.log('[UPLOAD] Creating ZIP from', fileList.length, 'individual files');
      const zipBuffer = await createZipFromFiles(fileList);
      
      // Convert Buffer to Uint8Array for Blob/File creation
      const zipArray = new Uint8Array(zipBuffer);
      const zipBlob = new Blob([zipArray], { type: 'application/zip' });
      zipFile = new File([zipBlob], 'dicom_folder.zip', { type: 'application/zip' });
    }

    // Call FastAPI to start compression job
    console.log('[UPLOAD] Calling FastAPI at:', FASTAPI_URL);
    console.log('[UPLOAD] ZIP file size:', zipFile.size, 'bytes');
    
    const jobResponse = await uploadAndCompress(zipFile, true);

    console.log('[UPLOAD] FastAPI response received:', {
      jobId: jobResponse.job_id,
      status: jobResponse.status,
      message: jobResponse.message,
    });

    // Use job_id as scanId for compatibility with existing flow
    // The job will process in background, and we'll fetch bundle data when complete
    const scanId = jobResponse.job_id;

    return NextResponse.json({
      scanId,
      message: 'Upload successful. Processing started.',
    });
  } catch (error) {
    console.error('[UPLOAD] Error:', error);
    return NextResponse.json(
      { 
        error: 'Upload failed', 
        message: error instanceof Error ? error.message : 'Unknown error',
        details: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    );
  }
}

/**
 * Create ZIP buffer from array of files
 */
async function createZipFromFiles(files: File[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const archive = archiver('zip', { zlib: { level: 9 } });

  return new Promise((resolve, reject) => {
    archive.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    archive.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    archive.on('error', (err: Error) => {
      reject(err);
    });

    // Add each file to the ZIP
    (async () => {
      for (const file of files) {
        const arrayBuffer = await file.arrayBuffer();
        archive.append(Buffer.from(arrayBuffer), { name: file.name });
      }
      archive.finalize();
    })();
  });
}
