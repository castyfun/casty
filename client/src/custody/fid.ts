import type { Address } from "viem";
import type { Cache } from "../config.js";
import { ConfigError, UsageError } from "../errors.js";
import type { NodeClient } from "../node/http.js";

/**
 * The fid whose custody address is `address`: from the node's id-registry events, or, when the
 * node does not know it (still syncing), from IdRegistry.idOf over an OP Mainnet RPC.
 */
export async function fidForAddress(
  node: NodeClient,
  address: Address,
  opRpc?: string,
): Promise<number> {
  const event = await node.idRegistryEventByAddress(address);
  if (event?.idRegisterEventBody?.to.toLowerCase() === address.toLowerCase()) return event.fid;
  if (opRpc) {
    const fid = await idOf(opRpc, address);
    if (fid > 0) return fid;
  }
  throw new ConfigError(
    `no fid is registered to ${address}`,
    opRpc
      ? "check --address-index"
      : "check --address-index; if your node is still syncing, pass --op-rpc <OP Mainnet RPC url>",
  );
}

async function idOf(rpcUrl: string, address: Address): Promise<number> {
  // Only the --op-rpc fallback needs these, so they load here rather than at startup.
  const [{ ID_REGISTRY_ADDRESS, idRegistryABI }, { createPublicClient, http }, { optimism }] =
    await Promise.all([import("@farcaster/core"), import("viem"), import("viem/chains")]);
  // export declare function createPublicClient<transport, chain, ...>(parameters: PublicClientConfig<...>): PublicClient<...>;
  // export declare function http<rpcSchema, raw>(url?: string, config?: HttpTransportConfig<rpcSchema, raw>): HttpTransport<rpcSchema, raw>;
  const client = createPublicClient({ chain: optimism, transport: http(rpcUrl) });
  // declare const ID_REGISTRY_ADDRESS: "0x00000000Fc6c5F01Fc30151999387Bb99A9f489b"; declare const idRegistryABI: readonly [...];
  // client.readContract: (parameters: ReadContractParameters<abi, functionName, args>) => Promise<ReadContractReturnType<abi, functionName, args>>
  const id = await client.readContract({
    address: ID_REGISTRY_ADDRESS,
    abi: idRegistryABI,
    functionName: "idOf",
    args: [address],
  });
  return Number(id);
}

/**
 * The fid that owns an fname: the node's username proofs first, then (if allowed) the public
 * fname registry, which needs no key. Results are cached by the caller-supplied cache.
 */
export async function fidForName(
  node: NodeClient,
  name: string,
  fnameServer: string | undefined,
  cache?: Cache<number>,
): Promise<number> {
  // fnames are lowercase; "@Alice" is the same name.
  const bare = name.replace(/^@/, "").toLowerCase();
  const cached = cache?.get(bare);
  if (cached) return cached;
  const fid =
    (await node.userNameProofByName(bare))?.fid ??
    (fnameServer && (await fromFnameServer(fnameServer, bare)));
  if (!fid) {
    const hint = fnameServer
      ? "check the spelling, or pass the fid"
      : "the node does not know it; pass the fid";
    throw new UsageError(`no fid found for @${bare}`, hint);
  }
  cache?.set(bare, fid);
  cache?.save();
  return fid;
}

async function fromFnameServer(server: string, name: string): Promise<number | undefined> {
  try {
    const res = await fetch(`${server}/transfers?name=${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return undefined;
    const { transfers } = (await res.json()) as { transfers?: { to?: number }[] };
    return transfers?.at(-1)?.to || undefined;
  } catch {
    return undefined;
  }
}
