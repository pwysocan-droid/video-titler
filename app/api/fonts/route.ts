import { NextRequest, NextResponse } from 'next/server'
import opentype from 'opentype.js'

export async function POST(request: NextRequest) {
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ valid: false, error: 'Failed to parse form data' }, { status: 400 })
  }

  const fontFile = formData.get('font') as File | null
  if (!fontFile) {
    return NextResponse.json({ valid: false, error: 'No font file provided' }, { status: 400 })
  }

  const ext = fontFile.name.split('.').pop()?.toLowerCase()
  if (!['ttf', 'otf'].includes(ext ?? '')) {
    return NextResponse.json({ valid: false, error: 'Font must be a .ttf or .otf file' }, { status: 400 })
  }

  let arrayBuffer: ArrayBuffer
  try {
    arrayBuffer = await fontFile.arrayBuffer()
  } catch {
    return NextResponse.json({ valid: false, error: 'Failed to read font file' }, { status: 400 })
  }

  try {
    const font = opentype.parse(arrayBuffer)
    const familyName = font.names.fontFamily?.en ?? font.names.fullName?.en ?? 'Unknown'
    const subfamilyName = font.names.fontSubfamily?.en ?? 'Regular'

    return NextResponse.json({ valid: true, familyName, subfamilyName })
  } catch (err) {
    console.error('opentype.js parse error:', err)
    return NextResponse.json({ valid: false, error: 'Invalid or unreadable font file' }, { status: 400 })
  }
}
