'use client'

import { useRef, useState, useEffect, SyntheticEvent } from 'react'
import { TitleCard } from '@/types'
import styles from './VideoPlayer.module.css'

interface VideoPlayerProps {
  videoUrl: string
  titles: TitleCard[]
  onTimeUpdate?: (time: number) => void
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 10)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${ms}`
}

export default function VideoPlayer({ videoUrl, titles, onTimeUpdate }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [videoSize, setVideoSize] = useState({ width: 0, height: 0 })
  const containerRef = useRef<HTMLDivElement>(null)

  function handleTimeUpdate(e: SyntheticEvent<HTMLVideoElement>) {
    const t = e.currentTarget.currentTime
    setCurrentTime(t)
    onTimeUpdate?.(t)
  }

  function handleLoadedMetadata(e: SyntheticEvent<HTMLVideoElement>) {
    setDuration(e.currentTarget.duration)
  }

  function handlePlay() { setIsPlaying(true) }
  function handlePause() { setIsPlaying(false) }
  function handleEnded() { setIsPlaying(false) }

  function handleVideoResize() {
    const video = videoRef.current
    if (!video) return
    setVideoSize({ width: video.offsetWidth, height: video.offsetHeight })
  }

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const observer = new ResizeObserver(handleVideoResize)
    observer.observe(video)
    return () => observer.disconnect()
  }, [])

  // Active titles at current time
  const activeTitles = titles.filter(
    (t) => currentTime >= t.startTime && currentTime <= t.endTime
  )

  return (
    <div className={styles.wrapper} ref={containerRef}>
      <div className={styles.videoContainer}>
        <video
          ref={videoRef}
          className={styles.video}
          src={videoUrl}
          onTimeUpdate={handleTimeUpdate}
          onLoadedMetadata={handleLoadedMetadata}
          onPlay={handlePlay}
          onPause={handlePause}
          onEnded={handleEnded}
          controls
        />

        {/* Overlay titles */}
        {videoSize.width > 0 &&
          activeTitles.map((title) => {
            const textAlign = title.align as 'left' | 'center' | 'right'
            const leftPct = title.x * 100
            const topPct = title.y * 100

            return (
              <div
                key={title.id}
                className={styles.titleOverlay}
                style={{
                  left: `${leftPct}%`,
                  top: `${topPct}%`,
                  fontSize: `${(title.fontSize / 64) * 2}em`,
                  color: title.color,
                  textAlign,
                  transform: title.align === 'center' ? 'translateX(-50%)' : title.align === 'right' ? 'translateX(-100%)' : 'none',
                }}
              >
                {title.text}
              </div>
            )
          })}
      </div>

      <div className={styles.timeBar}>
        <span className={styles.timecode}>{formatTimestamp(currentTime)}</span>
        <span className={styles.separator}>/</span>
        <span className={styles.timecode}>{formatTimestamp(duration)}</span>
        <span className={styles.status}>{isPlaying ? 'PLAYING' : 'PAUSED'}</span>
      </div>
    </div>
  )
}
