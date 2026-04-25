import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Sealdex is a monorepo: this frontend has its own yarn.lock, but
  // node_modules and the IDL live one level up. Pin the trace root so
  // Next.js stops printing the "multiple lockfiles" warning on each build
  // and includes the right files when collecting build traces.
  outputFileTracingRoot: resolve(__dirname, ".."),
};

export default nextConfig;
