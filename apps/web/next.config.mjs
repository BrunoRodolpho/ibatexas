import createNextIntlPlugin from "next-intl/plugin"

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts")

const isDev = process.env.NODE_ENV !== "production"
const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001"

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@ibatexas/types", "@ibatexas/ui"],
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.medusajs.com" },
      { protocol: "https", hostname: "**.amazonaws.com" },
      { protocol: "https", hostname: "**.cloudinary.com" },
      // Development-only patterns
      ...(isDev
        ? [
            { protocol: "http", hostname: "localhost" },
            { protocol: "https", hostname: "images.unsplash.com" },
          ]
        : []),
    ],
    deviceSizes: [640, 750, 828, 1080, 1200],
    imageSizes: [16, 32, 48, 64, 96, 128, 256],
  },

  // ── Security Headers (S2) ────────────────────────────────────────────
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "on" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://app.posthog.com",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https://*.medusajs.com https://*.amazonaws.com https://*.cloudinary.com",
              `connect-src 'self' https://app.posthog.com ${apiUrl}${isDev ? ' http://*:3001' : ''}`,
              "font-src 'self' https://fonts.gstatic.com",
              "media-src 'self'",
              "frame-ancestors 'none'",
            ].join("; "),
          },
        ],
      },
    ]
  },
}

export default withNextIntl(nextConfig)
