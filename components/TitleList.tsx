'use client'

import { TitleCard, DEFAULT_TITLE } from '@/types'
import styles from './TitleList.module.css'

interface TitleListProps {
  titles: TitleCard[]
  onChange: (titles: TitleCard[]) => void
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  const sInt = Math.floor(s)
  const sDec = Math.round((s - sInt) * 10)
  return `${String(m).padStart(2, '0')}:${String(sInt).padStart(2, '0')}.${sDec}`
}

function parseTime(str: string): number {
  const parts = str.split(':')
  if (parts.length === 2) {
    const mins = parseFloat(parts[0]) || 0
    const secs = parseFloat(parts[1]) || 0
    return mins * 60 + secs
  }
  return parseFloat(str) || 0
}

export default function TitleList({ titles, onChange }: TitleListProps) {
  function updateTitle(id: string, patch: Partial<TitleCard>) {
    onChange(titles.map((t) => (t.id === id ? { ...t, ...patch } : t)))
  }

  function deleteTitle(id: string) {
    onChange(titles.filter((t) => t.id !== id))
  }

  function addTitle() {
    const newTitle: TitleCard = {
      ...DEFAULT_TITLE,
      id: crypto.randomUUID(),
    }
    onChange([...titles, newTitle])
  }

  return (
    <div className={styles.container}>
      <div className={styles.listHeader}>
        <span className={styles.label}>Title Cards</span>
        <span className={styles.count}>{titles.length}</span>
      </div>

      <div className={styles.list}>
        {titles.length === 0 && (
          <div className={styles.empty}>No title cards yet. Click Add or run Analyze.</div>
        )}

        {titles.map((title, index) => (
          <div key={title.id} className={styles.row}>
            <div className={styles.rowHeader}>
              <span className={styles.rowIndex}>{String(index + 1).padStart(2, '0')}</span>
              <div className={styles.timeRange}>
                <input
                  className={styles.timeInput}
                  defaultValue={formatTime(title.startTime)}
                  onBlur={(e) => updateTitle(title.id, { startTime: parseTime(e.target.value) })}
                  title="Start time (MM:SS.s)"
                />
                <span className={styles.timeSep}>—</span>
                <input
                  className={styles.timeInput}
                  defaultValue={formatTime(title.endTime)}
                  onBlur={(e) => updateTitle(title.id, { endTime: parseTime(e.target.value) })}
                  title="End time (MM:SS.s)"
                />
              </div>
              <button
                className={styles.deleteBtn}
                onClick={() => deleteTitle(title.id)}
                title="Delete title card"
              >
                ×
              </button>
            </div>

            <div className={styles.rowBody}>
              <input
                className={styles.textInput}
                value={title.text}
                onChange={(e) => updateTitle(title.id, { text: e.target.value })}
                placeholder="Title text..."
              />
            </div>

            <div className={styles.rowControls}>
              <div className={styles.controlGroup}>
                <label className={styles.controlLabel}>SIZE</label>
                <select
                  className={styles.select}
                  value={title.fontSize}
                  onChange={(e) => updateTitle(title.id, { fontSize: Number(e.target.value) })}
                >
                  <option value={48}>48</option>
                  <option value={64}>64</option>
                  <option value={80}>80</option>
                </select>
              </div>

              <div className={styles.controlGroup}>
                <label className={styles.controlLabel}>ALIGN</label>
                <select
                  className={styles.select}
                  value={title.align}
                  onChange={(e) =>
                    updateTitle(title.id, { align: e.target.value as TitleCard['align'] })
                  }
                >
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </div>

              <div className={styles.controlGroup}>
                <label className={styles.controlLabel}>COLOR</label>
                <div className={styles.colorWrap}>
                  <input
                    type="color"
                    className={styles.colorInput}
                    value={title.color}
                    onChange={(e) => updateTitle(title.id, { color: e.target.value })}
                    title="Title color"
                  />
                  <span className={styles.colorHex}>{title.color.toUpperCase()}</span>
                </div>
              </div>

              <div className={styles.controlGroup}>
                <label className={styles.controlLabel}>POS X/Y</label>
                <div className={styles.posGroup}>
                  <input
                    className={styles.posInput}
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={title.x}
                    onChange={(e) => updateTitle(title.id, { x: parseFloat(e.target.value) })}
                    title="X position (0–1)"
                  />
                  <input
                    className={styles.posInput}
                    type="number"
                    min={0}
                    max={1}
                    step={0.01}
                    value={title.y}
                    onChange={(e) => updateTitle(title.id, { y: parseFloat(e.target.value) })}
                    title="Y position (0–1)"
                  />
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <button className={styles.addBtn} onClick={addTitle}>
        + Add Title Card
      </button>
    </div>
  )
}
