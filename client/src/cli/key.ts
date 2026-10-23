import type { Command } from "commander";
import { readConfig, writeConfig } from "../config.js";
import { ConfigError, UsageError } from "../errors.js";
import { requestFidOf } from "../feed/clients.js";
import { generateKey, privateKeyBytes, withSigner } from "../keys/signer.js";
import { loadKeys, updateKeys } from "../keys/store.js";
import type { Hex } from "../node/http.js";
import { signerRows, signerTable } from "./clients.js";
import {
  type Context,
  contextFor,
  type Io,
  mnemonic,
  passphrase,
  requireConfig,
} from "./context.js";
import { wholeNumber } from "./format.js";

interface RevokeFlags {
  self?: boolean;
  mnemonicStdin?: boolean;
  addressIndex: number;
}

export function registerKey(program: Command, io: Io): void {
  const key = program.command("key").description("your app keys");
  key
    .command("list")
    .description("keys registered to your fid, marking the ones casty holds")
    .action(async (_flags, command: Command) => {
      const ctx = contextFor(command, io);
      const rows = await signerRows(ctx, undefined);
      ctx.print(rows, await signerTable(rows));
    });
  key
    .command("revoke")
    .description("remove an app key from your fid (KEY_REMOVE); with no key, your newest")
    .argument("[key]", "0x public key to revoke")
    .option("--self", "sign the removal with the key itself; no seed phrase needed")
    .option("--mnemonic-stdin", "read the seed phrase from stdin instead of a hidden prompt")
    .option("--address-index <n>", "custody account index in the seed phrase", wholeNumber, 0)
    .action((target: string | undefined, flags: RevokeFlags, command: Command) =>
      revoke(contextFor(command, io), target, flags),
    );
}

async function revoke(
  ctx: Context,
  requested: string | undefined,
  flags: RevokeFlags,
): Promise<void> {
  const config = requireConfig(ctx);
  // The signing code is loaded only by the commands that sign.
  const [hub, { hexToBytes }, { deriveCustody }, keyadd, { submitAndConfirm }] = await Promise.all([
    import("@farcaster/core"),
    import("viem"),
    import("../custody/mnemonic.js"),
    import("../protocol/keyadd.js"),
    import("../submit/confirm.js"),
  ]);
  const { authDeadline, buildCustodyRevoke, buildSelfRevoke } = keyadd;
  const target = (requested?.toLowerCase() ?? config.keys.at(-1)) as Hex | undefined;
  if (!target) throw new ConfigError("casty holds no app key to revoke", "pass the key to revoke");
  const { signers } = await ctx.node.signersByFid(config.fid);
  const signer = signers.find((s) => s.key === target);
  if (!signer) throw new UsageError(`${target} is not an active key of fid ${config.fid}`);
  if (signer.source === "SIGNER_SOURCE_ONCHAIN") {
    throw new UsageError("onchain keys are removed onchain (KeyRegistry), not with KEY_REMOVE");
  }
  const gone = async () =>
    !(await ctx.node.signersByFid(config.fid)).signers.some((s) => s.key === target);
  const ours = config.keys.includes(target);
  const pass = ours || flags.self ? await passphrase(ctx, false) : undefined;
  const records = pass === undefined ? [] : loadKeys(ctx.dir, pass);

  if (flags.self) {
    const record = records.find((r) => r.fid === config.fid && `0x${r.pubkey}` === target);
    if (!record)
      throw new ConfigError(
        "--self needs the key in casty's store, and this one is not",
        "revoke it with your seed phrase instead",
      );
    const requestFid = requestFidOf(signer) ?? config.fid;
    const { requesterFidNonces } = await ctx.node.signersByFid(config.fid, [requestFid]);
    const input = {
      fid: config.fid,
      requesterNonce: requesterFidNonces[String(requestFid)] ?? 0,
      deadline: authDeadline(),
    };
    await withSigner(privateKeyBytes(record.privkey), async (key) => {
      await submitAndConfirm(ctx.node, await buildSelfRevoke(input, key), gone, ctx.confirm);
    });
  } else {
    const custody = deriveCustody(await mnemonic(ctx, flags.mnemonicStdin), flags.addressIndex);
    if (custody.address.toLowerCase() !== config.custodyAddress.toLowerCase()) {
      throw new ConfigError(
        `this seed phrase does not hold the custody address of fid ${config.fid}`,
        "check --address-index",
      );
    }
    const { currentUserNonce } = await ctx.node.signersByFid(config.fid);
    const input = {
      fid: config.fid,
      key: hexToBytes(target),
      currentUserNonce,
      deadline: authDeadline(),
    };
    // Custody revocation is authorized by the EIP-712 signature; any ed25519 key may sign the envelope.
    const envelope = await generateKey();
    await withSigner(envelope.privkey, async (key) => {
      await submitAndConfirm(
        ctx.node,
        await buildCustodyRevoke(input, new hub.ViemLocalEip712Signer(custody), key),
        gone,
        ctx.confirm,
      );
    });
  }

  // Over what the store and the config hold now, which another casty may have written meanwhile.
  if (pass !== undefined)
    updateKeys(ctx.dir, pass, (stored) => stored.filter((r) => `0x${r.pubkey}` !== target));
  const current = readConfig(ctx.dir) ?? config;
  writeConfig(ctx.dir, { ...current, keys: current.keys.filter((k) => k !== target) });
  ctx.print({ revoked: target }, `revoked ${target}`);
}
