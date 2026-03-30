'use client'

import { useRef, useState, DragEvent, ChangeEvent } from 'react'
import styles from './Upload.module.css'

interface UploadProps {
  onFileSelect: (file: File) => void
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function Upload({ onFileSelect }: UploadProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  function handleFile(file: File) {
    setSelectedFile(file)
    onFileSelect(file)
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setIsDragging(true)
  }

  function handleDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setIsDragging(false)
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setIsDragging(false)
    const file = e.dataTransfer.files[0]
    if (file && file.type.startsWith('video/')) {
      handleFile(file)
    }
  }

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
  }

  return (
    <div
      className={`${styles.dropZone} ${isDragging ? styles.dragging : ''} ${selectedFile ? styles.hasFile : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept="video/mp4,video/mov,video/quicktime,video/webm,video/*"
        onChange={handleChange}
        className={styles.hiddenInput}
      />

      {selectedFile ? (
        <div className={styles.fileInfo}>
          <div className={styles.fileIcon}>&#9654;</div>
          <div className={styles.fileMeta}>
            <span className={styles.fileName}>{selectedFile.name}</span>
            <span className={styles.fileSize}>{formatBytes(selectedFile.size)}</span>
          </div>
        </div>
      ) : (
        <div className={styles.prompt}>
          <div className={styles.plusIcon}>+</div>
          <p className={styles.promptText}>Drop video here or click to browse</p>
          <p className={styles.promptSub}>MP4 · MOV · WEBM</p>
        </div>
      )}
    </div>
  )
}
