import express, { Request, Response } from 'express'
import cors from 'cors'
import multer from 'multer'
import { execFile } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
// @ts-ignore — ffmpeg-static types
import ffmpegStatic from 'ffmpeg-static'
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
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
})

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true })
})

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

    const inputPath = path.join(tmpDir, `input${path.extname(videoFile.originalname) || '.mp4'}`)
    const outputPath = path.join(tmpDir, 'output.mp4')
    let fontPath: string | null = null

    try {
      // Write input video
      fs.writeFileSync(inputPath, videoFile.buffer)

      // Write font if provided
      if (fontFile) {
        fontPath = path.join(tmpDir, `font${path.extname(fontFile.originalname) || '.ttf'}`)
        fs.writeFileSync(fontPath, fontFile.buffer)
      }

      const ffmpegBin = (ffmpegStatic as unknown as string)
      if (!ffmpegBin) {
        return res.status(500).json({ error: 'ffmpeg-static binary not found' })
      }

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
          '-vf', filterStr,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '22',
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
      })
      readStream.on('error', (err) => {
        console.error('Stream error:', err)
        cleanup(tmpDir)
      })
    } catch (err) {
      console.error('Render error:', err)
      cleanup(tmpDir)
      if (!res.headersSent) {
        return res.status(500).json({ error: 'FFmpeg render failed', details: String(err) })
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

app.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`Render service listening on 0.0.0.0:${PORT}`)
})
