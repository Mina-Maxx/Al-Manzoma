/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  async rewrites() {
    const backendUrl = process.env.BACKEND_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
    return [
      {
        source: '/auth/:path*',
        destination: `${backendUrl}/auth/:path*`,
      },
      {
        source: '/me',
        destination: `${backendUrl}/me`,
      },
      {
        source: '/me/:path*',
        destination: `${backendUrl}/me/:path*`,
      },
      {
        source: '/platform/:path*',
        destination: `${backendUrl}/platform/:path*`,
      },
      {
        source: '/company/:path*',
        destination: `${backendUrl}/company/:path*`,
      },
      {
        source: '/quarries/:path*',
        destination: `${backendUrl}/quarries/:path*`,
      },
      {
        source: '/documents/:path*',
        destination: `${backendUrl}/documents/:path*`,
      },
      {
        source: '/health',
        destination: `${backendUrl}/health`,
      },
      {
        source: '/api/:path*',
        destination: `${backendUrl}/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
