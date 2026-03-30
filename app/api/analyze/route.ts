import { NextRequest, NextResponse } from 'next/server'
import { GoogleGenAI } from '@google/genai'
import { TitleCard, AnalyzeResponse } from '@/types'

export const maxDuration = 300

export async function POST(request: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'GEMINI_API_KEY is not configured' }, { status: 500 })
  }

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Failed to parse form data' }, { status: 400 })
  }

  const videoFile = formData.get('video') as File | null
  if (!videoFile) {
    return NextResponse.json({ error: 'No video file provided' }, { status: 400 })
  }

  const genAI = new GoogleGenAI({ apiKey })

  // Convert File to buffer for upload
  const arrayBuffer = await videoFile.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  // Upload file to Gemini File API
  let uploadedFile: { uri: string; name: string; state?: string }
  try {
    const uploadResponse = await genAI.files.upload({
      file: new Blob([buffer], { type: videoFile.type || 'video/mp4' }),
      config: {
        mimeType: videoFile.type || 'video/mp4',
        displayName: videoFile.name,
      },
    })
    uploadedFile = uploadResponse as { uri: string; name: string; state?: string }
  } catch (err) {
    console.error('Failed to upload to Gemini:', err)
    return NextResponse.json({ error: 'Failed to upload video to Gemini' }, { status: 500 })
  }

  // Poll until file is ACTIVE
  const maxWaitMs = 120_000
  const pollInterval = 3_000
  const startTime = Date.now()

  while (true) {
    if (Date.now() - startTime > maxWaitMs) {
      return NextResponse.json({ error: 'Timed out waiting for Gemini file processing' }, { status: 504 })
    }

    const fileState = uploadedFile.state
    if (fileState === 'ACTIVE') {
      break
    } else if (fileState === 'FAILED') {
      return NextResponse.json({ error: 'Gemini file processing failed' }, { status: 500 })
    }

    // Poll for updated state
    await new Promise((res) => setTimeout(res, pollInterval))
    try {
      const updatedFile = await genAI.files.get({ name: uploadedFile.name })
      uploadedFile = updatedFile as { uri: string; name: string; state?: string }
    } catch (err) {
      console.error('Failed to poll file state:', err)
      return NextResponse.json({ error: 'Failed to poll Gemini file state' }, { status: 500 })
    }
  }

  const prompt = `Analyze this video and suggest title card text overlays — chapter titles, section markers, mood phrases, or context labels that would enhance the viewing experience typographically.

For each title:
- text: concise, typographic (1–6 words)
- startTime / endTime: precise seconds when it should appear/disappear
- x, y: 0–1 normalized position (keep in safe zone: x 0.05–0.85, y 0.05–0.85)
- fontSize: 48 | 64 | 80 (choose based on title importance)
- color: "#FFFFFF" or "#0A0A08" based on what reads best
- align: "left" | "center" | "right"

Also estimate video duration, resolution (width × height), fps.

Return ONLY valid JSON, no markdown fences, no explanation:
{
  "titles": [ { "text": "...", "startTime": 0, "endTime": 3, "x": 0.08, "y": 0.08, "fontSize": 64, "color": "#FFFFFF", "align": "left" } ],
  "duration": 60.0,
  "width": 1920,
  "height": 1080,
  "fps": 24,
  "styleNotes": "..."
}`

  let rawText: string
  try {
    const result = await genAI.models.generateContent({
      model: 'gemini-1.5-pro',
      contents: [
        {
          role: 'user',
          parts: [
            {
              fileData: {
                mimeType: videoFile.type || 'video/mp4',
                fileUri: uploadedFile.uri,
              },
            },
            { text: prompt },
          ],
        },
      ],
    })
    rawText = result.text ?? ''
  } catch (err) {
    console.error('Gemini generateContent failed:', err)
    return NextResponse.json({ error: 'Gemini analysis failed' }, { status: 500 })
  }

  // Strip markdown fences if present
  let jsonText = rawText.trim()
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim()
  }

  let parsed: Omit<AnalyzeResponse, 'titles'> & { titles: Omit<TitleCard, 'id'>[] }
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    console.error('Failed to parse Gemini JSON:', jsonText)
    return NextResponse.json({ error: 'Failed to parse Gemini response as JSON' }, { status: 500 })
  }

  const titlesWithIds: TitleCard[] = (parsed.titles || []).map((t) => ({
    ...t,
    id: crypto.randomUUID(),
  }))

  const response: AnalyzeResponse = {
    titles: titlesWithIds,
    duration: parsed.duration ?? 0,
    width: parsed.width ?? 1920,
    height: parsed.height ?? 1080,
    fps: parsed.fps ?? 24,
    styleNotes: parsed.styleNotes ?? '',
  }

  return NextResponse.json(response)
}
