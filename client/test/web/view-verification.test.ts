import { describe, expect, it } from "vitest";
import { verificationOf } from "../../src/web/view.js";
import { cast } from "../feed/helpers.js";

describe("a verified address as the page shows it", () => {
  const message = (body: Record<string, unknown>) =>
    cast(1, 1, "a", {
      type: "MESSAGE_TYPE_VERIFICATION_ADD_ETH_ADDRESS",
      verificationAddAddressBody: body as never,
    });

  it("keeps an Ethereum address as hex, lowercased", () => {
    expect(
      verificationOf(message({ address: `0x${"AB".repeat(20)}`, protocol: "PROTOCOL_ETHEREUM" })),
    ).toEqual({
      protocol: "ethereum",
      address: `0x${"ab".repeat(20)}`,
    });
  });

  it("keeps a Solana address as the node prints it, which is base58 already", () => {
    // 32 bytes, base58: the form a mainnet node (snap.farcaster.xyz, Snapchain 0.14.2) prints.
    const printed = "US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx";
    expect(
      verificationOf(message({ address: printed, protocol: "PROTOCOL_SOLANA" }))?.address,
    ).toBe(printed);
  });
});
