/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  reactStrictMode: true,
  turbopack: {
    root: new URL(".", import.meta.url).pathname
  }
};

export default nextConfig;
