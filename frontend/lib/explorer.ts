/**
 * Solana Explorer URL helpers. Defaults to devnet because that's what the
 * Sealdex deployment runs on; override the cluster via the second argument
 * if a deployment ever points at testnet/mainnet.
 */

type Cluster = "devnet" | "testnet" | "mainnet-beta";

const DEFAULT_CLUSTER: Cluster = "devnet";

function clusterParam(c: Cluster): string {
  return c === "mainnet-beta" ? "" : `?cluster=${c}`;
}

export function explorerAddress(
  pubkey: string,
  cluster: Cluster = DEFAULT_CLUSTER,
): string {
  return `https://explorer.solana.com/address/${pubkey}${clusterParam(cluster)}`;
}

export function explorerTx(
  signature: string,
  cluster: Cluster = DEFAULT_CLUSTER,
): string {
  return `https://explorer.solana.com/tx/${signature}${clusterParam(cluster)}`;
}

export function shortPubkey(pk: string): string {
  if (!pk || pk.length < 12) return pk;
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}

export function shortSig(sig: string): string {
  if (!sig || sig.length < 12) return sig;
  return `${sig.slice(0, 6)}…${sig.slice(-6)}`;
}
