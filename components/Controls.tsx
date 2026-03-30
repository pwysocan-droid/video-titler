'use client'

import { useRef, useState, ChangeEvent } from 'react'
import styles from './Controls.module.css'

interface ControlsProps {
  renderUrl: string
  onRenderUrlChange: (url: string) => void
  fontName: string | null
  onFontSelect: (file: File, name: string) => void
  onExport: () => void
  isProcessing: boolean
  exportProgress: string | null
}

export default function Controls({
  renderUrl,
  onRenderUrlChange,
  fontName,
  onFontSelect,
  onExport,
  isProcessing,
  exportProgress,
}: ControlsProps) {
  const fontInputRef = useRef<HTMLInputElement>(null)
  const [fontError, setFontError] = useState<string | null>(null)
  const [isValidatingFont, setIsValidatingFont] = useState(false)

  async function handleFontChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setFontError(null)
    setIsValidatingFont(true)

    const formData = new FormData()
    formData.append('font', file)

    try {
      const res = await fetch('/api/fonts', { method: 'POST', body: formData })
      const data = await res.json()

      if (data.valid) {
        const displayName = data.subfamilyName && data.subfamilyName !== 'Regular'
          ? `${data.familyName} ${data.subfamilyName}`
          : data.familyName
        onFontSelect(file, displayName)
      } else {
        setFontError(data.error || 'Invalid font file')
      }
    } catch {
      setFontError('Failed to validate font')
    } finally {
      setIsValidatingFont(false)
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.section}>
        <label className={styles.sectionLabel}>Render Service URL</label>
        <input
          className={styles.urlInput}
          type="url"
          value={renderUrl}
          onChange={(e) => onRenderUrlChange(e.target.value)}
          placeholder="https://your-service.railway.app"
        />
        <p className={styles.hint}>Deploy render-service to Railway and paste the URL here</p>
      </div>

      <div className={styles.section}>
        <label className={styles.sectionLabel}>Custom Font</label>
        <div className={styles.fontRow}>
          <button
            className={styles.fontBtn}
            onClick={() => fontInputRef.current?.click()}
            disabled={isValidatingFont}
          >
            {isValidatingFont ? 'Validating...' : 'Upload .TTF'}
          </button>
          {fontName && (
            <span className={styles.fontName}>{fontName}</span>
          )}
        </div>
        <input
          ref={fontInputRef}
          type="file"
          accept=".ttf,.otf"
          onChange={handleFontChange}
          style={{ display: 'none' }}
        />
        {fontError && <p className={styles.error}>{fontError}</p>}
        {!fontName && !fontError && (
          <p className={styles.hint}>Optional — use a custom .ttf for title cards</p>
        )}
      </div>

      <div className={styles.exportSection}>
        <button
          className={styles.exportBtn}
          onClick={onExport}
          disabled={isProcessing || !renderUrl.trim()}
        >
          {isProcessing ? 'Rendering...' : 'Export Video'}
        </button>

        {exportProgress && (
          <div className={styles.progress}>
            <div className={styles.progressBar}>
              <div className={styles.progressFill} />
            </div>
            <span className={styles.progressText}>{exportProgress}</span>
          </div>
        )}

        {!renderUrl.trim() && (
          <p className={styles.warn}>Set render service URL to export</p>
        )}
      </div>
    </div>
  )
}
