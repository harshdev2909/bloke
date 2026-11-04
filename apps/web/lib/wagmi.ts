import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { monadTestnet } from "@bloke/sdk";

/**
 * Injected wallets (MetaMask, Rabby, Phantom, Backpack…). The embedded-wallet provider is still an
 * open question (PRD §22 Q3); adding one is a connector here, nothing else changes.
 */
export const wagmiConfig = createConfig({
  chains: [monadTestnet],
  connectors: [injected({ shimDisconnect: true })],
  transports: { [monadTestnet.id]: http("https://testnet-rpc.monad.xyz") },
  pollingInterval: 300,
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
