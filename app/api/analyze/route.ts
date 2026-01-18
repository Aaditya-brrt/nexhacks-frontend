import { NextRequest, NextResponse } from 'next/server';
import { google } from '@ai-sdk/google';
import { streamText } from 'ai';
import { getPixelData, getAllStoredScanIds } from '@/lib/dicom-processor';

// Allow streaming responses up to 60 seconds for AI analysis
export const maxDuration = 60;

// AI streaming analysis endpoint
// TODO: Replace with actual backend integration
export async function POST(request: NextRequest) {
  console.log('[ANALYZE] POST /api/analyze called');
  
  try {
    const body = await request.json();
    console.log('[ANALYZE] Request body:', { scanId: body.scanId });
    const { scanId } = body;

    if (!scanId) {
      console.error('[ANALYZE] Missing scanId parameter');
      return NextResponse.json(
        { error: 'scanId parameter is required' },
        { status: 400 }
      );
    }

    // Retrieve pixel JSON data for the scan
    const pixelData = getPixelData(scanId);
    const allStoredIds = getAllStoredScanIds();
    console.log('[ANALYZE] Pixel data found:', !!pixelData, 'for scanId:', scanId);
    console.log('[ANALYZE] All stored scanIds:', allStoredIds);

    if (!pixelData) {
      console.error('[ANALYZE] Pixel data not found for scanId:', scanId);
      console.error('[ANALYZE] Available scanIds in storage:', allStoredIds);
      return NextResponse.json(
        { 
          error: 'Pixel data not found for this scan. Please ensure the scan was uploaded and processed.',
          requestedScanId: scanId,
          availableScanIds: allStoredIds
        },
        { status: 404 }
      );
    }

    // Prepare prompt and image for AI analysis
    // Use base64 PNG string directly (AI SDK expects base64 string)
    const prompt = `You are a medical imaging AI assistant. Analyze the provided medical scan image and provide a diagnostic summary.

Scan Details:
- Modality: ${pixelData.modality}
- Dimensions: ${pixelData.width}x${pixelData.height} pixels
- Number of slices: ${pixelData.slices}

Please analyze the medical scan image and provide:
1. A comprehensive diagnostic summary describing any abnormalities, normal findings, or notable features
2. A confidence assessment of the analysis
3. Key findings as bullet points
4. Any recommendations for further clinical correlation if needed

Format your response as a medical diagnostic report. Be professional and precise. Remember this is for research and demonstration purposes only.`;

    // Use Vercel AI SDK with Google Generative AI (Gemini)
    // Gemini supports images in the message content as base64 strings
    // TODO: Configure API key via environment variable
    // GOOGLE_GENERATIVE_AI_API_KEY should be set in .env.local
    console.log('[ANALYZE] Starting AI stream with Google Gemini');
    console.log('[ANALYZE] Base64 PNG length:', pixelData.base64Png.length, 'characters');
    
    const result = streamText({
      model: google('gemini-2.5-flash'), 
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: prompt,
            },
            {
              type: 'image',
              image: pixelData.base64Png, // Base64 string directly
            },
          ],
        },
      ],
      temperature: 0.3, // Lower temperature for more focused medical analysis
    });

    console.log('[ANALYZE] Stream created successfully, returning response');
    // Return streamed response
    // This uses the AI SDK's text stream format compatible with streaming UI
    return result.toTextStreamResponse();
  } catch (error) {
    console.error('[ANALYZE] Error details:', {
      message: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      type: typeof error,
      error: error
    });
    return NextResponse.json(
      { 
        error: 'Failed to analyze scan', 
        message: error instanceof Error ? error.message : 'Unknown error',
        details: error instanceof Error ? error.stack : undefined
      },
      { status: 500 }
    );
  }
}
