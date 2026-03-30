'use client'

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
  onExport,
  isProcessing,
  exportProgress,
}: ControlsProps) {
  return (
    <div className={styles.container}>
      <div className={styles.section}>
        <label className={styles.sectionLabel}>Render Service URL</label>
        <input
          className={styles.urlInput}
          type="url"
          value={renderUrl}
          onChange={(e) => onRenderUrlChange(e.target.value)}
          placeholder="https://your-service.fly.dev"
        />
        <p className={styles.hint}>Render service URL (Fly.io / Railway)</p>
      </div>

      {fontName && (
        <div className={styles.section}>
          <label className={styles.sectionLabel}>Font</label>
          <span className={styles.fontName}>{fontName}</span>
        </div>
      )}

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
