/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: { serverActions: { bodySizeLimit: '500mb' } },
  api: { bodyParser: { sizeLimit: '500mb' } },
}

module.exports = nextConfig
