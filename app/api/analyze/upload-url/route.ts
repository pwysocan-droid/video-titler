import { NextRequest, NextResponse } from 'next/server'

export const maxDuration = 30

// Returns a Gemini resumable upload session URL.
// The browser uses this to upload the video file directly to Gemini —
// bypassing Vercel entirely, so there's no 4.5MB body size limit.
export async function GET(request: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'GEMINI_API_KEY not configured' }, { status: 500 })
  }

  const { searchParams } = new URL(request.url)
  const mimeType  = searchParams.get('mimeType')  || 'video/mp4'
  const fileName  = searchParams.get('fileName')  || 'video'
  const fileSize  = searchParams.get('fileSize')  || '0'

  const res = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=resumable&key=${apiKey}`,
    {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol':              'resumable',
        'X-Goog-Upload-Command':               'start',
        'X-Goog-Upload-Header-Content-Length': fileSize,
        'X-Goog-Upload-Header-Content-Type':   mimeType,
        'Content-Type':                        'application/json',
      },
      body: JSON.stringify({ file: { display_name: fileName } }),
    }
  )

  if (!res.ok) {
    const err = await res.text()
    return NextResponse.json({ error: `Gemini upload init failed: ${err}` }, { status: 500 })
  }

  const uploadUrl = res.headers.get('X-Goog-Upload-URL')
  if (!uploadUrl) {
    return NextResponse.json({ error: 'No upload URL returned by Gemini' }, { status: 500 })
  }

  return NextResponse.json({ uploadUrl })
}
