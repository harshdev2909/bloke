import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@bloke/sdk", "@bloke/shared"],
  // wagmi optional peer deps (WalletConnect, MetaMask SDK) aren't used; keep them out of the bundle.
  turbopack: {},
};

export default config;
