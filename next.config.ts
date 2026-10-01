import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // One image containing the server and its pruned dependency tree.
  output: 'standalone',
  // Keeps `next dev` from appending its own block to the hand-written CLAUDE.md.
  agentRules: false,
}

export default nextConfig
