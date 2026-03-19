const isDev = process.env.NODE_ENV !== 'production'
const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@ibatexas/types', '@ibatexas/ui'],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.medusajs.com' },
      { protocol: 'https', hostname: '**.amazonaws.com' },
      ...(isDev
        ? [{ protocol: 'http', hostname: 'localhost' }]
        : []),
    ],
  },

  // ── Security Headers ──────────────────────────────────────────────────
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // AUDIT-FIX: FE-C2 — Remove unsafe-eval; only needed in dev for Next.js hot-reload
              `script-src 'self' 'unsafe-inline' ${isDev ? "'unsafe-eval'" : ""}`,
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https://*.medusajs.com https://*.amazonaws.com",
              `connect-src 'self' ${apiUrl}${isDev ? ' http://*:3001' : ''}`,
              "font-src 'self' https://fonts.gstatic.com",
              "media-src 'self'",
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
    ]
  },
}

export default nextConfig
