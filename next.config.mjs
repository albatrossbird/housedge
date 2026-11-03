/** @type {import('next').NextConfig} */
const nextConfig = {
  /* config options here */
  reactStrictMode: true,
  // The sign-up page was /signin first; old links and bookmarks still land.
  // Next carries the query string (?next=, ?error=) across on its own.
  async redirects() {
    return [{ source: "/signin", destination: "/signup", permanent: false }];
  },
};

export default nextConfig;
