import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'edge'

// Proxies the video upload to Gemini's resumable upload API.
// Using Edge runtime removes Vercel's 4.5MB body size limit —
// Edge functions stream the request body rather than buffering it.
export async function POST(request: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'GEMINI_API_KEY not configured' }, { status: 500 })
  }

  const { searchParams } = new URL(request.url)
  const mimeType  = searchParams.get('mimeType')  || 'video/mp4'
  const fileName  = searchParams.get('fileName')  || 'video'
  const fileSize  = searchParams.get('fileSize')  || '0'

  // Step 1: init resumable upload session with Gemini
  const initRes = await fetch(
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

  if (!initRes.ok) {
    const err = await initRes.text()
    return NextResponse.json({ error: `Upload init failed: ${err}` }, { status: 500 })
  }

  const uploadUrl = initRes.headers.get('X-Goog-Upload-URL')
  if (!uploadUrl) {
    return NextResponse.json({ error: 'No upload URL from Gemini' }, { status: 500 })
  }

  // Step 2: stream the request body directly to Gemini's upload URL
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset':  '0',
      'Content-Type':          mimeType,
    },
    body: await request.arrayBuffer(),
  } as RequestInit)

  if (!uploadRes.ok) {
    const err = await uploadRes.text()
    return NextResponse.json({ error: `Upload to Gemini failed: ${err}` }, { status: 500 })
  }

  const data = await uploadRes.json()
  return NextResponse.json({
    fileName: data.file?.name,
    fileUri:  data.file?.uri,
  })
}
