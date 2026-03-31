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
