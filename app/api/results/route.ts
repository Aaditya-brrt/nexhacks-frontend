import { NextRequest, NextResponse } from 'next/server';

// Mock results endpoint
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

    // Results should come from the streaming AI analysis, not mock data
    // This endpoint should only be used if streaming AI completes and stores results
    // For now, return an error indicating results should come from the AI stream
    return NextResponse.json(
      { 
        error: 'Results are generated via streaming AI analysis. Please wait for the AI analysis to complete.', 
        message: 'This endpoint is deprecated. Results come from the /api/analyze streaming endpoint.'
      },
      { status: 404 }
    );
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch results', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
