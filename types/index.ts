export interface TitleCard {
  id: string
  text: string
  startTime: number   // seconds
  endTime: number     // seconds
  x: number           // 0–1 normalized (0=left edge)
  y: number           // 0–1 normalized (0=top edge)
  fontSize: number    // pt, default 64
  color: string       // hex, default '#FFFFFF'
  align: 'left' | 'center' | 'right'
}

export interface AnalyzeResponse {
  titles: TitleCard[]
  duration: number
  width: number
  height: number
  fps: number
  styleNotes: string
}

export interface AppState {
  step: 'upload' | 'analyze' | 'edit' | 'export'
  videoFile: File | null
  videoUrl: string | null
  fontFile: File | null
  fontName: string | null
  titles: TitleCard[]
  duration: number
  videoWidth: number
  videoHeight: number
  isProcessing: boolean
  error: string | null
}

// ── Highlight Reel types ──

export type AspectRatio = '16:9' | '9:16' | '1:1' | '4:3'

export interface ReelSegment {
  id: string
  clipIndex: number       // which uploaded video
  clipName: string
  startTime: number       // seconds within source clip
  endTime: number         // seconds within source clip
  title: TitleCard | null
  focusX: number          // 0–1, center of interest (for smart crop)
  focusY: number          // 0–1
}

export interface ReelSettings {
  targetDuration: number  // seconds
  aspectRatio: AspectRatio
}

export interface ReelAnalyzeResponse {
  segments: ReelSegment[]
  styleNotes: string
}

export interface ReelAppState {
  step: 'upload' | 'settings' | 'analyze' | 'edit' | 'export'
  videoFiles: File[]
  videoUrls: string[]
  fontFile: File | null
  fontName: string | null
  segments: ReelSegment[]
  settings: ReelSettings
  isProcessing: boolean
  analyzeProgress: string | null
  error: string | null
}

export const DEFAULT_TITLE: Omit<TitleCard, 'id'> = {
  text: 'Title',
  startTime: 0,
  endTime: 3,
  x: 0.08,
  y: 0.08,
  fontSize: 64,
  color: '#FFFFFF',
  align: 'left',
}
