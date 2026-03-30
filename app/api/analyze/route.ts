import { NextRequest, NextResponse } from 'next/server'
import { GoogleGenAI } from '@google/genai'
import { TitleCard, AnalyzeResponse } from '@/types'

export const maxDuration = 300

const PROMPT = `Analyze this video and suggest title card text overlays — chapter titles, section markers, mood phrases, or context labels that would enhance the viewing experience typographically.

For each title:
- text: concise, typographic (1–6 words)
- startTime / endTime: precise seconds when it should appear/disappear
- x, y: 0–1 normalized position (keep in safe zone: x 0.05–0.85, y 0.05–0.85)
- fontSize: 48 | 64 | 80 (choose based on title importance)
- color: "#FFFFFF" or "#0A0A08" based on what reads best against the background
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

export async function POST(request: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    return NextResponse.json({ error: 'GEMINI_API_KEY is not configured' }, { status: 500 })
  }

  let body: { fileName: string; fileUri: string; mimeType: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { fileName, fileUri, mimeType } = body
  if (!fileName || !fileUri) {
    return NextResponse.json({ error: 'fileName and fileUri are required' }, { status: 400 })
  }

  const genAI = new GoogleGenAI({ apiKey })

  // Poll until file is ACTIVE (Gemini processes video server-side after upload)
  const maxWaitMs  = 120_000
  const pollMs     = 3_000
  const startTime  = Date.now()
  let   fileState  = 'PROCESSING'

  while (fileState !== 'ACTIVE') {
    if (Date.now() - startTime > maxWaitMs) {
      return NextResponse.json({ error: 'Timed out waiting for Gemini to process video' }, { status: 504 })
    }
    if (fileState === 'FAILED') {
      return NextResponse.json({ error: 'Gemini video processing failed' }, { status: 500 })
    }

    await new Promise((r) => setTimeout(r, pollMs))

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const file = await genAI.files.get({ name: fileName }) as any
      fileState = file.state ?? 'PROCESSING'
    } catch (err) {
      console.error('Poll error:', err)
      return NextResponse.json({ error: 'Failed to poll Gemini file state' }, { status: 500 })
    }
  }

  // Generate title suggestions
  let rawText: string
  try {
    const result = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { mimeType: mimeType || 'video/mp4', fileUri } },
            { text: PROMPT },
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

  const titles: TitleCard[] = (parsed.titles || []).map((t) => ({
    ...t,
    id: crypto.randomUUID(),
  }))

  const response: AnalyzeResponse = {
    titles,
    duration:    parsed.duration    ?? 0,
    width:       parsed.width       ?? 1920,
    height:      parsed.height      ?? 1080,
    fps:         parsed.fps         ?? 24,
    styleNotes:  parsed.styleNotes  ?? '',
  }

  return NextResponse.json(response)
}
