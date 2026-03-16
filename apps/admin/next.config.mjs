/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@ibatexas/types', '@ibatexas/ui'],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.medusajs.com' },
      { protocol: 'https', hostname: '**.amazonaws.com' },
      ...(process.env.NODE_ENV !== 'production'
        ? [{ protocol: 'http', hostname: 'localhost' }]
        : []),
    ],
  },
}

export default nextConfig
