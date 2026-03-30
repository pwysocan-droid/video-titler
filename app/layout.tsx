import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Video Titler',
  description: 'AI-powered video title card overlay tool',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
