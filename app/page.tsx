'use client'

import { useState, useRef } from 'react'
import { AppState, TitleCard, AnalyzeResponse } from '@/types'
import Upload from '@/components/Upload'
import TitleList from '@/components/TitleList'
import VideoPlayer from '@/components/VideoPlayer'
import Controls from '@/components/Controls'
import styles from './page.module.css'

const STEPS = [
  { id: 'upload', num: '01', label: 'Upload' },
  { id: 'analyze', num: '02', label: 'Analyze' },
  { id: 'edit', num: '03', label: 'Edit' },
  { id: 'export', num: '04', label: 'Export' },
] as const

const initialState: AppState = {
  step: 'upload',
  videoFile: null,
  videoUrl: null,
  fontFile: null,
  fontName: null,
  titles: [],
  duration: 0,
  videoWidth: 0,
  videoHeight: 0,
  isProcessing: false,
  error: null,
}

export default function Page() {
  const [state, setState] = useState<AppState>(initialState)
  const [renderUrl, setRenderUrl] = useState(
    process.env.NEXT_PUBLIC_RENDER_URL || 'http://localhost:3001'
  )
  const [exportProgress, setExportProgress] = useState<string | null>(null)
  const [styleNotes, setStyleNotes] = useState<string>('')
  const [fontError, setFontError] = useState<string | null>(null)
  const [isValidatingFont, setIsValidatingFont] = useState(false)
  const fontInputRef = useRef<HTMLInputElement>(null)

  function patch(updates: Partial<AppState>) {
    setState((prev) => ({ ...prev, ...updates }))
  }

  // Step 01: File selected → advance to analyze
  function handleFileSelect(file: File) {
    const url = URL.createObjectURL(file)
    patch({
      videoFile: file,
      videoUrl: url,
      step: 'analyze',
      error: null,
    })
  }

  // Step 02: Analyze video with Gemini
  // Three-step flow: get upload URL → browser uploads direct to Gemini → analyze
  // This bypasses Vercel's 4.5MB body limit entirely.
  async function handleAnalyze() {
    if (!state.videoFile) return
    patch({ isProcessing: true, error: null })

    try {
      const file = state.videoFile
      const mimeType = file.type || 'video/mp4'

      // 1. Upload video via Fly.io proxy — no body size limit
      const uploadForm = new FormData()
      uploadForm.append('video', file)
      const uploadRes = await fetch(
        `${renderUrl.replace(/\/$/, '')}/api/upload`,
        { method: 'POST', body: uploadForm }
      )
      if (!uploadRes.ok) {
        const e = await uploadRes.json().catch(() => ({ error: 'Upload failed' }))
        throw new Error(e.error || 'Failed to upload video')
      }
      const { fileName, fileUri } = await uploadRes.json()
      if (!fileName || !fileUri) throw new Error('Upload response missing file info')

      // 3. Analyze on Fly.io — no timeout constraints
      const analyzeRes = await fetch(`${renderUrl.replace(/\/$/, '')}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName, fileUri, mimeType }),
      })
      if (!analyzeRes.ok) {
        const e = await analyzeRes.json().catch(() => ({ error: 'Unknown error' }))
        throw new Error(e.error || `HTTP ${analyzeRes.status}`)
      }

      const data: AnalyzeResponse = await analyzeRes.json()
      setStyleNotes(data.styleNotes || '')
      patch({
        titles:      data.titles,
        duration:    data.duration,
        videoWidth:  data.width,
        videoHeight: data.height,
        step:        'edit',
        isProcessing: false,
      })
    } catch (err) {
      patch({
        isProcessing: false,
        error: err instanceof Error ? err.message : 'Analysis failed',
      })
    }
  }

  // Step 03: Edit titles
  function handleTitlesChange(titles: TitleCard[]) {
    patch({ titles })
  }

  async function handleFontUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setFontError(null)
    setIsValidatingFont(true)
    try {
      const formData = new FormData()
      formData.append('font', file)
      const res = await fetch('/api/fonts', { method: 'POST', body: formData })
      const data = await res.json()
      if (data.valid) {
        const name = data.subfamilyName && data.subfamilyName !== 'Regular'
          ? `${data.familyName} ${data.subfamilyName}`
          : data.familyName
        patch({ fontFile: file, fontName: name })
      } else {
        setFontError(data.error || 'Invalid font file')
      }
    } catch {
      setFontError('Failed to validate font')
    } finally {
      setIsValidatingFont(false)
    }
  }

  function handleFontSelect(file: File, name: string) {
    patch({ fontFile: file, fontName: name })
  }

  // Step 04: Export
  async function handleExport() {
    if (!state.videoFile) return
    if (!renderUrl.trim()) {
      patch({ error: 'Render service URL is not configured' })
      return
    }

    patch({ isProcessing: true, error: null })
    setExportProgress('Sending to render service...')

    try {
      const formData = new FormData()
      formData.append('video', state.videoFile)
      formData.append('titles', JSON.stringify(state.titles))
      if (state.fontFile) {
        formData.append('font', state.fontFile)
      }

      const res = await fetch(`${renderUrl.replace(/\/$/, '')}/api/render`, {
        method: 'POST',
        body: formData,
      })

      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error(errData.error || `HTTP ${res.status}`)
      }

      setExportProgress('Downloading rendered video...')

      const blob = await res.blob()
      const downloadUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const baseName = state.videoFile.name.replace(/\.[^.]+$/, '')
      a.href = downloadUrl
      a.download = `${baseName}-titled.mp4`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(downloadUrl)

      setExportProgress(null)
      patch({ isProcessing: false })
    } catch (err) {
      setExportProgress(null)
      patch({
        isProcessing: false,
        error: err instanceof Error ? err.message : 'Export failed',
      })
    }
  }

  function goToStep(step: AppState['step']) {
    // Only allow navigating to steps we've already reached or current
    const order: AppState['step'][] = ['upload', 'analyze', 'edit', 'export']
    const currentIdx = order.indexOf(state.step)
    const targetIdx = order.indexOf(step)
    if (targetIdx <= currentIdx || (step === 'export' && state.titles.length > 0)) {
      patch({ step })
    }
  }

  const stepOrder: AppState['step'][] = ['upload', 'analyze', 'edit', 'export']
  const currentStepIdx = stepOrder.indexOf(state.step)

  function isStepReachable(stepId: AppState['step']) {
    const idx = stepOrder.indexOf(stepId)
    if (idx <= currentStepIdx) return true
    if (stepId === 'export' && state.titles.length > 0) return true
    return false
  }

  return (
    <div className={styles.app}>
      {/* Header */}
      <header className={styles.header}>
        <span className={styles.headerTitle}>Video Titler</span>
        <span className={styles.headerMeta}>
          {state.videoFile ? state.videoFile.name : 'No file loaded'}
        </span>
        <span className={styles.headerStatus}>
          <span className={`${styles.statusDot} ${state.isProcessing ? styles.active : ''}`} />
          {state.isProcessing ? 'Processing' : state.step.toUpperCase()}
        </span>
      </header>

      {/* Step Bar */}
      <nav className={styles.stepBar}>
        {STEPS.map(({ id, num, label }) => (
          <button
            key={id}
            className={`${styles.stepBtn} ${state.step === id ? styles.active : ''}`}
            onClick={() => goToStep(id)}
            disabled={!isStepReachable(id)}
          >
            <span className={styles.stepNum}>{num}</span>
            {label}
          </button>
        ))}
      </nav>

      {/* Error Banner */}
      {state.error && (
        <div className={styles.errorBanner}>
          <span>{state.error}</span>
          <button className={styles.errorClose} onClick={() => patch({ error: null })}>
            ×
          </button>
        </div>
      )}

      {/* Main Content */}
      <main className={styles.main}>
        {/* Step 01: Upload */}
        {state.step === 'upload' && (
          <div className={styles.uploadStep}>
            <h1 className={styles.uploadTitle}>Upload Video</h1>
            <div className={styles.uploadInner}>
              <Upload onFileSelect={handleFileSelect} />
            </div>
          </div>
        )}

        {/* Step 02: Analyze */}
        {state.step === 'analyze' && (
          <div className={styles.analyzeStep}>
            {state.videoUrl && (
              <div className={styles.videoPreview}>
                <video
                  className={styles.videoThumb}
                  src={state.videoUrl}
                  preload="metadata"
                  muted
                />
              </div>
            )}
            <div className={styles.analyzeControls}>
              {state.isProcessing ? (
                <div className={styles.analyzingState}>
                  <div className={styles.spinner} />
                  <span className={styles.analyzingText}>
                    Uploading to Gemini &amp; analyzing...
                  </span>
                </div>
              ) : (
                <button
                  className={styles.analyzeBtn}
                  onClick={handleAnalyze}
                  disabled={state.isProcessing}
                >
                  Analyze with Gemini
                </button>
              )}
              {styleNotes && (
                <p className={styles.styleNotes}>{styleNotes}</p>
              )}
            </div>
          </div>
        )}

        {/* Step 03: Edit */}
        {state.step === 'edit' && (
          <div className={styles.editStep}>
            <div className={styles.editSidebar}>
              <div className={styles.fontRow}>
                <span className={styles.sidebarLabel}>Font</span>
                <button
                  className={styles.fontBtn}
                  onClick={() => fontInputRef.current?.click()}
                  disabled={isValidatingFont}
                >
                  {isValidatingFont ? 'Checking...' : state.fontName ? state.fontName : 'Upload .TTF'}
                </button>
                <input
                  ref={fontInputRef}
                  type="file"
                  accept=".ttf,.otf"
                  onChange={handleFontUpload}
                  style={{ display: 'none' }}
                />
                {fontError && <span className={styles.fontError}>{fontError}</span>}
              </div>
              <TitleList titles={state.titles} onChange={handleTitlesChange} />
            </div>
            <div className={styles.editContent}>
              {state.videoUrl && (
                <VideoPlayer
                  videoUrl={state.videoUrl}
                  titles={state.titles}
                />
              )}
            </div>
          </div>
        )}

        {/* Step 04: Export */}
        {state.step === 'export' && (
          <div className={styles.exportStep}>
            <div className={styles.exportSidebar}>
              <Controls
                renderUrl={renderUrl}
                onRenderUrlChange={setRenderUrl}
                fontName={state.fontName}
                onFontSelect={handleFontSelect}
                onExport={handleExport}
                isProcessing={state.isProcessing}
                exportProgress={exportProgress}
              />
            </div>
            <div className={styles.exportContent}>
              {state.videoUrl && (
                <VideoPlayer
                  videoUrl={state.videoUrl}
                  titles={state.titles}
                />
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
