'use client'

import { useState, useRef } from 'react'
import { ReelAppState, ReelSegment, ReelSettings, AspectRatio, TitleCard } from '@/types'
import styles from './reel.module.css'

const STEPS = [
  { id: 'upload',   num: '01', label: 'Upload' },
  { id: 'settings', num: '02', label: 'Settings' },
  { id: 'analyze',  num: '03', label: 'Analyze' },
  { id: 'edit',     num: '04', label: 'Edit' },
] as const

const ASPECT_RATIOS: AspectRatio[] = ['16:9', '9:16', '1:1', '4:3']

const RENDER_URL = 'https://video-titler-render.fly.dev'

const initialState: ReelAppState = {
  step: 'upload',
  videoFiles: [],
  videoUrls: [],
  fontFile: null,
  fontName: null,
  segments: [],
  settings: { targetDuration: 60, aspectRatio: '16:9' },
  isProcessing: false,
  analyzeProgress: null,
  error: null,
}

export default function ReelPage() {
  const [state, setState] = useState<ReelAppState>(initialState)
  const [exportProgress, setExportProgress] = useState<string | null>(null)
  const fontInputRef = useRef<HTMLInputElement>(null)

  function patch(updates: Partial<ReelAppState>) {
    setState(prev => ({ ...prev, ...updates }))
  }

  const stepOrder: ReelAppState['step'][] = ['upload', 'settings', 'analyze', 'edit']
  const currentIdx = stepOrder.indexOf(state.step)

  function isStepReachable(stepId: ReelAppState['step']) {
    const idx = stepOrder.indexOf(stepId)
    if (idx <= currentIdx) return true
    if (stepId === 'edit' && state.segments.length > 0) return true
    return false
  }

  function goToStep(step: ReelAppState['step']) {
    if (isStepReachable(step)) patch({ step })
  }

  // Step 01: files selected
  function handleFilesSelect(files: FileList | null) {
    if (!files || files.length === 0) return
    const arr = Array.from(files)
    const urls = arr.map(f => URL.createObjectURL(f))
    patch({ videoFiles: arr, videoUrls: urls, step: 'settings', error: null })
  }

  // Step 03: analyze all clips in parallel
  async function handleAnalyze() {
    const { videoFiles, settings } = state
    if (videoFiles.length === 0) return
    patch({ isProcessing: true, error: null, analyzeProgress: `Uploading ${videoFiles.length} clip${videoFiles.length > 1 ? 's' : ''}...` })

    try {
      // Upload all clips to Gemini in parallel
      const uploadResults = await Promise.all(
        videoFiles.map(async (file) => {
          const form = new FormData()
          form.append('video', file)
          const res = await fetch(`${RENDER_URL}/api/upload`, { method: 'POST', body: form })
          if (!res.ok) {
            const e = await res.json().catch(() => ({ error: 'Upload failed' }))
            throw new Error(`${file.name}: ${e.error || 'Upload failed'}`)
          }
          return res.json() as Promise<{ fileName: string; fileUri: string }>
        })
      )

      patch({ analyzeProgress: 'Analyzing with Gemini...' })

      // Analyze all clips on Fly.io
      const res = await fetch(`${RENDER_URL}/api/analyze-reel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clips: uploadResults.map((r, i) => ({
            fileName: r.fileName,
            fileUri: r.fileUri,
            mimeType: videoFiles[i].type || 'video/mp4',
            clipName: videoFiles[i].name,
          })),
          targetDuration: settings.targetDuration,
          aspectRatio: settings.aspectRatio,
        }),
      })

      if (!res.ok) {
        const e = await res.json().catch(() => ({ error: 'Analysis failed' }))
        throw new Error(e.error || 'Analysis failed')
      }

      const data = await res.json() as { segments: ReelSegment[] }
      patch({
        segments: data.segments,
        step: 'edit',
        isProcessing: false,
        analyzeProgress: null,
      })
    } catch (err) {
      patch({
        isProcessing: false,
        analyzeProgress: null,
        error: err instanceof Error ? err.message : 'Analysis failed',
      })
    }
  }

  // Step 04: edit segments
  function handleSegmentChange(id: string, updates: Partial<ReelSegment>) {
    patch({
      segments: state.segments.map(s => s.id === id ? { ...s, ...updates } : s),
    })
  }

  function handleTitleChange(segId: string, updates: Partial<TitleCard>) {
    patch({
      segments: state.segments.map(s => {
        if (s.id !== segId) return s
        return { ...s, title: s.title ? { ...s.title, ...updates } : null }
      }),
    })
  }

  function handleRemoveSegment(id: string) {
    patch({ segments: state.segments.filter(s => s.id !== id) })
  }

  async function handleFontUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
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
      }
    } catch { /* ignore */ }
  }

  // Export
  async function handleExport() {
    if (state.videoFiles.length === 0 || state.segments.length === 0) return
    patch({ isProcessing: true, error: null })
    setExportProgress('Sending to render service...')

    try {
      const formData = new FormData()
      state.videoFiles.forEach((f, i) => formData.append(`video_${i}`, f))
      formData.append('segments', JSON.stringify(state.segments))
      formData.append('settings', JSON.stringify(state.settings))
      if (state.fontFile) formData.append('font', state.fontFile)

      const res = await fetch(`${RENDER_URL}/api/render-reel`, { method: 'POST', body: formData })

      if (!res.ok) {
        const e = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
        throw new Error(e.error || `HTTP ${res.status}`)
      }

      setExportProgress('Downloading...')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `highlight-reel.mp4`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

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

  const totalDuration = state.segments.reduce((s, seg) => s + (seg.endTime - seg.startTime), 0)

  return (
    <div className={styles.app}>
      {/* Header */}
      <header className={styles.header}>
        <span className={styles.headerTitle}>Highlight Reel</span>
        <span className={styles.headerMeta}>
          {state.videoFiles.length > 0
            ? `${state.videoFiles.length} clip${state.videoFiles.length > 1 ? 's' : ''}`
            : 'No clips loaded'}
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
          <button className={styles.errorClose} onClick={() => patch({ error: null })}>×</button>
        </div>
      )}

      <main className={styles.main}>

        {/* Step 01: Upload */}
        {state.step === 'upload' && (
          <div className={styles.uploadStep}>
            <h1 className={styles.uploadTitle}>Upload Clips</h1>
            <label className={styles.dropzone}>
              <input
                type="file"
                multiple
                accept="video/*"
                style={{ display: 'none' }}
                onChange={e => handleFilesSelect(e.target.files)}
              />
              <span className={styles.dropzoneText}>Drop videos here or click to browse</span>
              <span className={styles.dropzoneHint}>MP4, MOV, any format · multiple files OK</span>
            </label>
          </div>
        )}

        {/* Step 02: Settings */}
        {state.step === 'settings' && (
          <div className={styles.settingsStep}>
            <div className={styles.settingsPanel}>
              <div className={styles.settingsGroup}>
                <label className={styles.settingsLabel}>Target Duration</label>
                <div className={styles.durationRow}>
                  <input
                    type="range"
                    min={10}
                    max={300}
                    step={5}
                    value={state.settings.targetDuration}
                    className={styles.slider}
                    onChange={e => patch({ settings: { ...state.settings, targetDuration: Number(e.target.value) } })}
                  />
                  <span className={styles.durationVal}>
                    {state.settings.targetDuration}s
                  </span>
                </div>
              </div>

              <div className={styles.settingsGroup}>
                <label className={styles.settingsLabel}>Aspect Ratio</label>
                <div className={styles.ratioRow}>
                  {ASPECT_RATIOS.map(r => (
                    <button
                      key={r}
                      className={`${styles.ratioBtn} ${state.settings.aspectRatio === r ? styles.active : ''}`}
                      onClick={() => patch({ settings: { ...state.settings, aspectRatio: r } })}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>

              <div className={styles.settingsGroup}>
                <label className={styles.settingsLabel}>Clips</label>
                <ul className={styles.clipList}>
                  {state.videoFiles.map((f, i) => (
                    <li key={i} className={styles.clipItem}>{f.name}</li>
                  ))}
                </ul>
              </div>

              <button className={styles.primaryBtn} onClick={() => patch({ step: 'analyze' })}>
                Continue →
              </button>
            </div>
          </div>
        )}

        {/* Step 03: Analyze */}
        {state.step === 'analyze' && (
          <div className={styles.analyzeStep}>
            {state.isProcessing ? (
              <div className={styles.analyzingState}>
                <div className={styles.spinner} />
                <span className={styles.analyzingText}>{state.analyzeProgress}</span>
              </div>
            ) : (
              <div className={styles.analyzeReady}>
                <p className={styles.analyzeDesc}>
                  Gemini will watch all {state.videoFiles.length} clip{state.videoFiles.length > 1 ? 's' : ''} in parallel,
                  select the best {state.settings.targetDuration}s of footage,
                  and suggest titles.
                </p>
                <button className={styles.primaryBtn} onClick={handleAnalyze}>
                  Analyze with Gemini
                </button>
              </div>
            )}
          </div>
        )}

        {/* Step 04: Edit */}
        {state.step === 'edit' && (
          <div className={styles.editStep}>
            <div className={styles.editSidebar}>
              <div className={styles.sidebarTop}>
                <div className={styles.fontRow}>
                  <span className={styles.sidebarLabel}>Font</span>
                  <button className={styles.fontBtn} onClick={() => fontInputRef.current?.click()}>
                    {state.fontName || 'Upload .TTF'}
                  </button>
                  <input ref={fontInputRef} type="file" accept=".ttf,.otf" onChange={handleFontUpload} style={{ display: 'none' }} />
                </div>
                <div className={styles.durationInfo}>
                  <span className={styles.sidebarLabel}>Total</span>
                  <span className={styles.durationVal}>{totalDuration.toFixed(1)}s / {state.settings.targetDuration}s target</span>
                </div>
              </div>

              <div className={styles.segmentList}>
                {state.segments.map((seg, i) => (
                  <div key={seg.id} className={styles.segment}>
                    <div className={styles.segmentHeader}>
                      <span className={styles.segmentNum}>{String(i + 1).padStart(2, '0')}</span>
                      <span className={styles.segmentName}>{seg.clipName}</span>
                      <button className={styles.removeBtn} onClick={() => handleRemoveSegment(seg.id)}>×</button>
                    </div>
                    <div className={styles.segmentTimes}>
                      <input
                        type="number"
                        className={styles.timeInput}
                        value={seg.startTime.toFixed(1)}
                        step={0.1}
                        min={0}
                        onChange={e => handleSegmentChange(seg.id, { startTime: Number(e.target.value) })}
                      />
                      <span className={styles.timeSep}>→</span>
                      <input
                        type="number"
                        className={styles.timeInput}
                        value={seg.endTime.toFixed(1)}
                        step={0.1}
                        min={0}
                        onChange={e => handleSegmentChange(seg.id, { endTime: Number(e.target.value) })}
                      />
                      <span className={styles.segDur}>({(seg.endTime - seg.startTime).toFixed(1)}s)</span>
                    </div>
                    {seg.title && (
                      <div className={styles.segmentTitle}>
                        <input
                          className={styles.titleInput}
                          value={seg.title.text}
                          onChange={e => handleTitleChange(seg.id, { text: e.target.value })}
                          placeholder="Title text..."
                        />
                        <div className={styles.titleMeta}>
                          <select
                            className={styles.titleSelect}
                            value={seg.title.fontSize}
                            onChange={e => handleTitleChange(seg.id, { fontSize: Number(e.target.value) })}
                          >
                            <option value={48}>48</option>
                            <option value={64}>64</option>
                            <option value={80}>80</option>
                          </select>
                          <select
                            className={styles.titleSelect}
                            value={seg.title.align}
                            onChange={e => handleTitleChange(seg.id, { align: e.target.value as TitleCard['align'] })}
                          >
                            <option value="left">L</option>
                            <option value="center">C</option>
                            <option value="right">R</option>
                          </select>
                          <input
                            type="color"
                            className={styles.colorInput}
                            value={seg.title.color}
                            onChange={e => handleTitleChange(seg.id, { color: e.target.value })}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <button
                className={styles.exportBtn}
                onClick={handleExport}
                disabled={state.isProcessing || state.segments.length === 0}
              >
                {state.isProcessing ? exportProgress || 'Exporting...' : 'Export Reel'}
              </button>
            </div>
          </div>
        )}

      </main>
    </div>
  )
}
