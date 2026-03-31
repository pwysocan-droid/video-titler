import express, { Request, Response } from 'express'
import cors from 'cors'
import multer from 'multer'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
// Use system ffmpeg installed via apt in Docker
const ffmpegStatic = 'ffmpeg'
import { GoogleGenAI } from '@google/genai'
import { TitleCard } from './types'

const execFileAsync = promisify(execFile)

const app = express()
const PORT = process.env.PORT || 3001
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:3000'

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (health checks, curl, etc.)
      if (!origin) return callback(null, true)
      if (
        origin === ALLOWED_ORIGIN ||
        origin.endsWith('.vercel.app') ||
        origin.endsWith('.railway.app')
      ) {
        return callback(null, true)
      }
      callback(new Error(`CORS: origin ${origin} not allowed`))
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
  })
)

app.use(express.json())

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, file, cb) => cb(null, `${uuidv4()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
})

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true })
})

// ── Upload proxy — streams video to Gemini resumable upload, no size limit ──

app.post(
  '/api/upload',
  upload.single('video'),
  async (req: Request, res: Response) => {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' })

    const videoFile = req.file
    if (!videoFile) return res.status(400).json({ error: 'No video file provided' })

    const mimeType = videoFile.mimetype || 'video/mp4'
    const fileName = videoFile.originalname || 'video'

    // 1. Init resumable upload session with Gemini
    const initRes = await fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=resumable&key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol':              'resumable',
          'X-Goog-Upload-Command':               'start',
          'X-Goog-Upload-Header-Content-Length': String(videoFile.size),
          'X-Goog-Upload-Header-Content-Type':   mimeType,
          'Content-Type':                        'application/json',
        },
        body: JSON.stringify({ file: { display_name: fileName } }),
      }
    )

    if (!initRes.ok) {
      const err = await initRes.text()
      return res.status(500).json({ error: `Upload init failed: ${err}` })
    }

    const uploadUrl = initRes.headers.get('X-Goog-Upload-URL')
    if (!uploadUrl) return res.status(500).json({ error: 'No upload URL from Gemini' })

    // 2. Stream the file from disk to Gemini
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Command': 'upload, finalize',
        'X-Goog-Upload-Offset':  '0',
        'Content-Type':          mimeType,
      },
      body: fs.readFileSync(videoFile.path),
    })

    cleanupFile(videoFile.path)

    if (!uploadRes.ok) {
      const err = await uploadRes.text()
      return res.status(500).json({ error: `Upload to Gemini failed: ${err}` })
    }

    const data = await uploadRes.json() as { file?: { name?: string; uri?: string } }
    res.json({
      fileName: data.file?.name,
      fileUri:  data.file?.uri,
    })
  }
)

// ── Escape helpers for FFmpeg drawtext ──

function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')   // backslash first
    .replace(/'/g, "'\\''")   // single quote
    .replace(/:/g, '\\:')     // colon
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
}

function alignToX(align: TitleCard['align'], x: number): string {
  switch (align) {
    case 'center':
      return `W*${x.toFixed(4)}-text_w/2`
    case 'right':
      return `W*${x.toFixed(4)}-text_w`
    default: // left
      return `W*${x.toFixed(4)}`
  }
}

function buildDrawtextFilter(titles: TitleCard[], fontPath: string | null): string {
  if (titles.length === 0) return 'null'

  return titles
    .map((t) => {
      const xExpr = alignToX(t.align, t.x)
      const yExpr = `H*${t.y.toFixed(4)}`
      const escapedText = escapeText(t.text)
      const color = t.color.replace('#', '')
      const fontPart = fontPath ? `fontfile='${fontPath}':` : ''

      return (
        `drawtext=${fontPart}` +
        `text='${escapedText}':` +
        `x=${xExpr}:` +
        `y=${yExpr}:` +
        `fontsize=${t.fontSize}:` +
        `fontcolor=${color}:` +
        `enable='between(t,${t.startTime},${t.endTime})'`
      )
    })
    .join(',')
}

// ── Analyze endpoint — no timeout constraints here unlike Vercel ──

const ANALYZE_PROMPT = `Analyze this video and suggest title card text overlays — chapter titles, section markers, mood phrases, or context labels that would enhance the viewing experience typographically.

For each title:
- text: concise, typographic (1–6 words)
- startTime / endTime: precise seconds when it should appear/disappear
- x, y: 0–1 normalized position (keep in safe zone: x 0.05–0.85, y 0.05–0.85)
- fontSize: 48 | 64 | 80 (choose based on title importance)
- color: "#FFFFFF" or "#0A0A08" based on what reads best against the background
- align: "left" | "center" | "right"

Also estimate video duration, resolution (width x height), fps.

Return ONLY valid JSON, no markdown fences, no explanation:
{"titles":[{"text":"...","startTime":0,"endTime":3,"x":0.08,"y":0.08,"fontSize":64,"color":"#FFFFFF","align":"left"}],"duration":60.0,"width":1920,"height":1080,"fps":24,"styleNotes":"..."}`

app.post('/api/analyze', async (req: Request, res: Response) => {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' })

  const { fileName, fileUri, mimeType } = req.body
  if (!fileName || !fileUri) {
    return res.status(400).json({ error: 'fileName and fileUri are required' })
  }

  const genAI = new GoogleGenAI({ apiKey })

  // Poll until ACTIVE
  const maxWaitMs = 180_000
  const pollMs    = 3_000
  const start     = Date.now()
  let   state     = 'PROCESSING'

  while (state !== 'ACTIVE') {
    if (Date.now() - start > maxWaitMs) {
      return res.status(504).json({ error: 'Timed out waiting for Gemini to process video' })
    }
    if (state === 'FAILED') {
      return res.status(500).json({ error: 'Gemini video processing failed' })
    }
    await new Promise((r) => setTimeout(r, pollMs))
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const file = await genAI.files.get({ name: fileName }) as any
      state = file.state ?? 'PROCESSING'
    } catch (err) {
      console.error('Poll error:', err)
      return res.status(500).json({ error: 'Failed to poll Gemini file state' })
    }
  }

  let rawText: string
  try {
    const result = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{
        role: 'user',
        parts: [
          { fileData: { mimeType: mimeType || 'video/mp4', fileUri } },
          { text: ANALYZE_PROMPT },
        ],
      }],
    })
    rawText = result.text ?? ''
  } catch (err) {
    console.error('generateContent failed:', err)
    return res.status(500).json({ error: 'Gemini analysis failed' })
  }

  let jsonText = rawText.trim()
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim()
  }

  let parsed: any
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    console.error('Failed to parse Gemini JSON:', jsonText)
    return res.status(500).json({ error: 'Failed to parse Gemini response' })
  }

  const titles = (parsed.titles || []).map((t: any) => ({
    ...t,
    id: uuidv4(),
  }))

  res.json({
    titles,
    duration:   parsed.duration   ?? 0,
    width:      parsed.width      ?? 1920,
    height:     parsed.height     ?? 1080,
    fps:        parsed.fps        ?? 24,
    styleNotes: parsed.styleNotes ?? '',
  })
})

// ── Render endpoint ──

app.post(
  '/api/render',
  upload.fields([
    { name: 'video', maxCount: 1 },
    { name: 'font', maxCount: 1 },
  ]),
  async (req: Request, res: Response) => {
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined
    const videoFile = files?.video?.[0]
    const fontFile = files?.font?.[0]

    if (!videoFile) {
      return res.status(400).json({ error: 'No video file provided' })
    }

    const titlesRaw = req.body?.titles
    let titles: TitleCard[] = []
    if (titlesRaw) {
      try {
        titles = JSON.parse(titlesRaw)
      } catch {
        return res.status(400).json({ error: 'Invalid titles JSON' })
      }
    }

    // Create temp directory for this job
    const jobId = uuidv4()
    const tmpDir = path.join(os.tmpdir(), `render-${jobId}`)
    fs.mkdirSync(tmpDir, { recursive: true })

    const inputPath = videoFile.path  // already on disk via diskStorage
    const outputPath = path.join(tmpDir, 'output.mp4')
    let fontPath: string | null = null

    try {
      // Write font if provided (font is small, buffer is fine)
      if (fontFile) {
        fontPath = path.join(tmpDir, `font${path.extname(fontFile.originalname) || '.ttf'}`)
        fs.renameSync(fontFile.path, fontPath)
      }

      const ffmpegBin = ffmpegStatic

      let ffmpegArgs: string[]

      if (titles.length === 0) {
        // No titles — just remux
        ffmpegArgs = [
          '-i', inputPath,
          '-c', 'copy',
          '-y',
          outputPath,
        ]
      } else {
        const filterStr = buildDrawtextFilter(titles, fontPath)
        ffmpegArgs = [
          '-i', inputPath,
          '-vf', `${filterStr},format=yuv420p`,
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', '23',
          '-c:a', 'copy',
          '-y',
          outputPath,
        ]
      }

      await execFileAsync(ffmpegBin, ffmpegArgs, {
        maxBuffer: 1024 * 1024 * 10, // 10 MB stdout/stderr buffer
      })

      if (!fs.existsSync(outputPath)) {
        return res.status(500).json({ error: 'FFmpeg produced no output file' })
      }

      const stat = fs.statSync(outputPath)
      res.setHeader('Content-Type', 'video/mp4')
      res.setHeader('Content-Length', stat.size)
      res.setHeader('Content-Disposition', 'attachment; filename="titled.mp4"')

      const readStream = fs.createReadStream(outputPath)
      readStream.pipe(res)
      readStream.on('end', () => {
        cleanup(tmpDir)
        cleanupFile(inputPath)
      })
      readStream.on('error', (err) => {
        console.error('Stream error:', err)
        cleanup(tmpDir)
        cleanupFile(inputPath)
      })
    } catch (err) {
      console.error('Render error:', err)
      cleanup(tmpDir)
      cleanupFile(inputPath)
      if (!res.headersSent) {
        return res.status(500).json({ error: 'FFmpeg render failed', details: String(err) })
      }
    }
  }
)

// ── Transcode endpoint — converts any video to H.264 MP4 for browser playback ──

app.post(
  '/api/transcode',
  upload.single('video'),
  async (req: Request, res: Response) => {
    const videoFile = req.file
    if (!videoFile) return res.status(400).json({ error: 'No video file provided' })

    const jobId = uuidv4()
    const tmpDir = path.join(os.tmpdir(), `transcode-${jobId}`)
    fs.mkdirSync(tmpDir, { recursive: true })

    const inputPath = videoFile.path  // already on disk via diskStorage
    const outputPath = path.join(tmpDir, 'output.mp4')

    try {

      const ffmpegBin = ffmpegStatic

      await execFileAsync(ffmpegBin, [
        '-i', inputPath,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '22',
        '-c:a', 'aac',
        '-movflags', '+faststart',
        '-y',
        outputPath,
      ], { maxBuffer: 1024 * 1024 * 10 })

      if (!fs.existsSync(outputPath)) {
        return res.status(500).json({ error: 'FFmpeg produced no output' })
      }

      const stat = fs.statSync(outputPath)
      res.setHeader('Content-Type', 'video/mp4')
      res.setHeader('Content-Length', stat.size)
      res.setHeader('Content-Disposition', 'inline; filename="video.mp4"')

      const readStream = fs.createReadStream(outputPath)
      readStream.pipe(res)
      readStream.on('end', () => { cleanup(tmpDir); cleanupFile(inputPath) })
      readStream.on('error', () => { cleanup(tmpDir); cleanupFile(inputPath) })
    } catch (err) {
      console.error('Transcode error:', err)
      cleanup(tmpDir)
      cleanupFile(inputPath)
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Transcode failed', details: String(err) })
      }
    }
  }
)

// ── Analyze Reel endpoint ──

const REEL_PROMPT = (targetDuration: number, aspectRatio: string, clipCount: number) => `
You are editing a highlight reel. You have ${clipCount} video clip(s). Select the most compelling, visually interesting moments that together form a cohesive ${targetDuration}-second highlight reel at ${aspectRatio} aspect ratio.

For each selected segment return:
- clipIndex: 0-based index of the source clip
- startTime / endTime: precise seconds within that clip
- title: a short 1–5 word title card overlay (or null if no title fits)
- focusX / focusY: 0–1 normalized center of the main subject (for smart crop when aspect ratio differs from source)

Rules:
- Total duration of all segments must be close to ${targetDuration} seconds
- Pick moments with clear action, expression, or visual interest — avoid boring transitions
- Order segments for good narrative flow
- Each segment should be at least 2 seconds, at most 20 seconds

Return ONLY valid JSON, no markdown fences:
{
  "segments": [
    {
      "clipIndex": 0,
      "startTime": 5.2,
      "endTime": 11.0,
      "focusX": 0.5,
      "focusY": 0.4,
      "title": {
        "text": "Opening Shot",
        "x": 0.08,
        "y": 0.08,
        "fontSize": 64,
        "color": "#FFFFFF",
        "align": "left"
      }
    }
  ]
}`

app.post('/api/analyze-reel', async (req: Request, res: Response) => {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' })

  const { clips, targetDuration, aspectRatio } = req.body as {
    clips: { fileName: string; fileUri: string; mimeType: string; clipName: string }[]
    targetDuration: number
    aspectRatio: string
  }

  if (!clips?.length) return res.status(400).json({ error: 'clips are required' })

  const genAI = new GoogleGenAI({ apiKey })

  // Poll all clips in parallel until ACTIVE
  const maxWaitMs = 180_000
  const pollMs = 3_000

  await Promise.all(clips.map(async (clip) => {
    const start = Date.now()
    let state = 'PROCESSING'
    while (state !== 'ACTIVE') {
      if (Date.now() - start > maxWaitMs) throw new Error(`Timed out waiting for ${clip.clipName}`)
      if (state === 'FAILED') throw new Error(`Gemini failed processing ${clip.clipName}`)
      await new Promise(r => setTimeout(r, pollMs))
      const file = await genAI.files.get({ name: clip.fileName }) as any
      state = file.state ?? 'PROCESSING'
    }
  }))

  // Build multi-clip prompt content
  const parts: any[] = [
    ...clips.map(clip => ({ fileData: { mimeType: clip.mimeType, fileUri: clip.fileUri } })),
    { text: REEL_PROMPT(targetDuration, aspectRatio, clips.length) },
  ]

  let rawText: string
  try {
    const result = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts }],
    })
    rawText = result.text ?? ''
  } catch (err) {
    console.error('generateContent failed:', err)
    return res.status(500).json({ error: 'Gemini analysis failed' })
  }

  let jsonText = rawText.trim()
  if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```[a-z]*\n?/, '').replace(/\n?```$/, '').trim()
  }

  let parsed: any
  try {
    parsed = JSON.parse(jsonText)
  } catch {
    console.error('Failed to parse Gemini JSON:', jsonText)
    return res.status(500).json({ error: 'Failed to parse Gemini response' })
  }

  const segments = (parsed.segments || []).map((s: any) => ({
    ...s,
    id: uuidv4(),
    clipName: clips[s.clipIndex]?.clipName ?? `clip_${s.clipIndex}`,
    title: s.title ? { ...s.title, id: uuidv4(), startTime: s.startTime, endTime: s.endTime } : null,
  }))

  res.json({ segments })
})

// ── Render Reel endpoint ──

// Compute FFmpeg crop filter to reframe source to target aspect ratio using focusX/Y
function buildCropFilter(
  srcW: number, srcH: number,
  targetRatio: number,
  focusX: number, focusY: number
): string {
  const srcRatio = srcW / srcH
  let cropW: number, cropH: number
  if (srcRatio > targetRatio) {
    // Source is wider — crop width
    cropH = srcH
    cropW = Math.round(srcH * targetRatio)
  } else {
    // Source is taller — crop height
    cropW = srcW
    cropH = Math.round(srcW / targetRatio)
  }
  // Center crop on focus point, clamped to valid range
  const focusPxX = Math.round(focusX * srcW)
  const focusPxY = Math.round(focusY * srcH)
  const x = Math.max(0, Math.min(srcW - cropW, focusPxX - cropW / 2))
  const y = Math.max(0, Math.min(srcH - cropH, focusPxY - cropH / 2))
  return `crop=${cropW}:${cropH}:${Math.round(x)}:${Math.round(y)}`
}

function ratioToNumber(ratio: string): number {
  const [w, h] = ratio.split(':').map(Number)
  return w / h
}

function ratioToResolution(ratio: string): { w: number; h: number } {
  const map: Record<string, { w: number; h: number }> = {
    '16:9': { w: 1920, h: 1080 },
    '9:16': { w: 1080, h: 1920 },
    '1:1':  { w: 1080, h: 1080 },
    '4:3':  { w: 1440, h: 1080 },
  }
  return map[ratio] ?? { w: 1920, h: 1080 }
}

app.post(
  '/api/render-reel',
  upload.any(),
  async (req: Request, res: Response) => {
    const files = (req.files as Express.Multer.File[]) ?? []
    const videoFiles = files
      .filter(f => f.fieldname.startsWith('video_'))
      .sort((a, b) => {
        const ai = parseInt(a.fieldname.replace('video_', ''))
        const bi = parseInt(b.fieldname.replace('video_', ''))
        return ai - bi
      })
    const fontFile = files.find(f => f.fieldname === 'font')

    if (videoFiles.length === 0) return res.status(400).json({ error: 'No video files provided' })

    let segments: any[], settings: { targetDuration: number; aspectRatio: string }
    try {
      segments = JSON.parse(req.body.segments)
      settings = JSON.parse(req.body.settings)
    } catch {
      return res.status(400).json({ error: 'Invalid segments or settings JSON' })
    }

    const jobId = uuidv4()
    const tmpDir = path.join(os.tmpdir(), `reel-${jobId}`)
    fs.mkdirSync(tmpDir, { recursive: true })

    let fontPath: string | null = null
    if (fontFile) {
      fontPath = path.join(tmpDir, `font${path.extname(fontFile.originalname) || '.ttf'}`)
      fs.renameSync(fontFile.path, fontPath)
    }

    const targetRatio = ratioToNumber(settings.aspectRatio)
    const targetRes = ratioToResolution(settings.aspectRatio)

    try {
      // Probe each source video for dimensions
      const probeDimensions = async (filePath: string): Promise<{ w: number; h: number }> => {
        try {
          const { stdout } = await execFileAsync('ffprobe', [
            '-v', 'quiet', '-print_format', 'json', '-show_streams', filePath
          ])
          const info = JSON.parse(stdout)
          const vs = info.streams?.find((s: any) => s.codec_type === 'video')
          return { w: vs?.width ?? 1920, h: vs?.height ?? 1080 }
        } catch {
          return { w: 1920, h: 1080 }
        }
      }

      // Build one trimmed+scaled segment file per segment
      const segmentFiles: string[] = []

      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]
        const srcFile = videoFiles[seg.clipIndex]
        if (!srcFile) continue

        const srcPath = srcFile.path
        const { w: srcW, h: srcH } = await probeDimensions(srcPath)
        const srcRatio = srcW / srcH
        const needsCrop = Math.abs(srcRatio - targetRatio) > 0.01

        const segOut = path.join(tmpDir, `seg_${i}.mp4`)
        segmentFiles.push(segOut)

        // Build video filter chain
        const filters: string[] = []
        if (needsCrop) {
          filters.push(buildCropFilter(srcW, srcH, targetRatio, seg.focusX ?? 0.5, seg.focusY ?? 0.4))
        }
        filters.push(`scale=${targetRes.w}:${targetRes.h}`)
        filters.push('format=yuv420p')

        // Add title drawtext if present
        if (seg.title?.text) {
          const t = seg.title
          const xExpr = t.align === 'center'
            ? `W*${t.x.toFixed(4)}-text_w/2`
            : t.align === 'right'
            ? `W*${t.x.toFixed(4)}-text_w`
            : `W*${t.x.toFixed(4)}`
          const yExpr = `H*${t.y.toFixed(4)}`
          const escapedText = t.text
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "'\\''")
            .replace(/:/g, '\\:')
            .replace(/\[/g, '\\[')
            .replace(/\]/g, '\\]')
          const color = t.color.replace('#', '')
          const fontPart = fontPath ? `fontfile='${fontPath}':` : ''
          // Title shows for full segment duration (time resets to 0 per segment)
          const dur = seg.endTime - seg.startTime
          filters.push(
            `drawtext=${fontPart}text='${escapedText}':x=${xExpr}:y=${yExpr}:` +
            `fontsize=${t.fontSize}:fontcolor=${color}:enable='between(t,0,${dur})'`
          )
        }

        await execFileAsync(ffmpegStatic, [
          '-ss', String(seg.startTime),
          '-to', String(seg.endTime),
          '-i', srcPath,
          '-vf', filters.join(','),
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', '23',
          '-c:a', 'aac',
          '-ar', '48000',
          '-y',
          segOut,
        ], { maxBuffer: 1024 * 1024 * 50 })
      }

      if (segmentFiles.length === 0) {
        return res.status(400).json({ error: 'No valid segments to render' })
      }

      // Concat all segments
      const outputPath = path.join(tmpDir, 'output.mp4')
      if (segmentFiles.length === 1) {
        fs.renameSync(segmentFiles[0], outputPath)
      } else {
        const concatList = path.join(tmpDir, 'concat.txt')
        fs.writeFileSync(concatList, segmentFiles.map(f => `file '${f}'`).join('\n'))
        await execFileAsync(ffmpegStatic, [
          '-f', 'concat',
          '-safe', '0',
          '-i', concatList,
          '-c', 'copy',
          '-y',
          outputPath,
        ], { maxBuffer: 1024 * 1024 * 10 })
      }

      if (!fs.existsSync(outputPath)) {
        return res.status(500).json({ error: 'FFmpeg produced no output' })
      }

      const stat = fs.statSync(outputPath)
      res.setHeader('Content-Type', 'video/mp4')
      res.setHeader('Content-Length', stat.size)
      res.setHeader('Content-Disposition', 'attachment; filename="highlight-reel.mp4"')

      const readStream = fs.createReadStream(outputPath)
      readStream.pipe(res)
      readStream.on('end', () => {
        cleanup(tmpDir)
        videoFiles.forEach(f => cleanupFile(f.path))
      })
      readStream.on('error', () => {
        cleanup(tmpDir)
        videoFiles.forEach(f => cleanupFile(f.path))
      })
    } catch (err) {
      console.error('Reel render error:', err)
      cleanup(tmpDir)
      videoFiles.forEach(f => cleanupFile(f.path))
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Reel render failed', details: String(err) })
      }
    }
  }
)

function cleanup(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (e) {
    console.error('Cleanup error:', e)
  }
}

function cleanupFile(filePath: string) {
  try {
    fs.rmSync(filePath, { force: true })
  } catch (e) {
    console.error('Cleanup file error:', e)
  }
}

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Render service listening on 0.0.0.0:${PORT}`)
})
