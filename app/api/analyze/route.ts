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
    // Use Flask-provided prompt if available, otherwise use default
    const defaultPrompt = `Analyze this ${pixelData.modality} scan image and provide ONLY a brief diagnosis (2-3 sentences) and 3-5 key bullet points.

Requirements:
- Keep response under 200 words total
- Use plain text only (no LaTeX, markdown formatting, or special characters)
- Brief diagnosis in first 2-3 sentences
- Follow with 3-5 key findings as simple bullet points (use "•" or "-" prefix)
- No tables, equations, or complex formatting

Format:
Brief Diagnosis: [2-3 sentence summary]
Key Findings:
• [First finding]
• [Second finding]
• [etc.]`;
    
    const prompt = pixelData.prompt || defaultPrompt;

    // Use Vercel AI SDK with Google Generative AI (Gemini)
    // Gemini supports images in the message content as base64 strings (raw base64, no data URL prefix)
    // The pixelData.base64Png is already a raw base64 string from getBundleFileAsBase64
    // TODO: Configure API key via environment variable
    // GOOGLE_GENERATIVE_AI_API_KEY should be set in .env.local
    console.log('[ANALYZE] Starting AI stream with Google Gemini');
    console.log('[ANALYZE] Base64 PNG length:', pixelData.base64Png.length, 'characters');
    console.log('[ANALYZE] Base64 PNG preview (first 50 chars):', pixelData.base64Png.substring(0, 50));
    
    // Validate base64 format (optional check)
    if (!pixelData.base64Png || pixelData.base64Png.length === 0) {
      throw new Error('Invalid base64 PNG data: empty or missing');
    }
    
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
              // Vercel AI SDK expects raw base64 string (no data:image/png;base64, prefix)
              // getBundleFileAsBase64 already returns raw base64 from the PNG file
              image: pixelData.base64Png,
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
