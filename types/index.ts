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
