import { NextRequest, NextResponse } from 'next/server';

// Mock status endpoint
// TODO: Replace with actual backend integration
export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const scanId = searchParams.get('scanId');

    if (!scanId) {
      return NextResponse.json(
        { error: 'scanId parameter is required' },
        { status: 400 }
      );
    }

    // Immediately jump to analyzing stage - no 60-second delay
    // The AI will stream responses immediately when analysis starts
    let stage: 'queued' | 'normalizing' | 'compressing' | 'analyzing' | 'completed' | 'error';
    let progress: number;
    let etaSeconds: number | null;

    if (scanId.includes('error')) {
      stage = 'error';
      progress = 0.5;
      etaSeconds = null;
    } else {
      // Immediately show as analyzing - AI will stream response
      stage = 'analyzing';
      progress = 0.7; // Show progress as analyzing
      etaSeconds = null; // No ETA for streaming AI
    }

    return NextResponse.json({
      scanId,
      stage,
      progress: Math.min(progress, 1.0),
      etaSeconds,
      errorMessage: stage === 'error' ? 'Processing failed: Unable to analyze scan data.' : null,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch status', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
