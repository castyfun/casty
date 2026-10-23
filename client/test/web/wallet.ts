import { TEST_MNEMONIC } from "@casty/mock-node";
import { mnemonicToAccount } from "viem/accounts";

/** The custody of ME_FID, as a wallet app holds it. */
export const wallet = mnemonicToAccount(TEST_MNEMONIC);

export interface TypedData {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}

/**
 * Signs as a wallet does with eth_signTypedData_v4: the JSON the page hands over, uint256 values
 * as decimal strings, which viem wants as bigints.
 */
export function signAsWallet(typedData: TypedData, account = wallet): Promise<`0x${string}`> {
  const { EIP712Domain: _, ...types } = typedData.types;
  const fields = typedData.types[typedData.primaryType] ?? [];
  const message = Object.fromEntries(
    Object.entries(typedData.message).map(([name, value]) => [
      name,
      fields.find((f) => f.name === name)?.type === "uint256" ? BigInt(value as string) : value,
    ]),
  );
  return account.signTypedData({
    domain: typedData.domain,
    types,
    primaryType: typedData.primaryType,
    message,
  } as never);
}
