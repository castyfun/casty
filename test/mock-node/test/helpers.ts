import {
  CastType,
  FarcasterNetwork,
  HashScheme,
  Message,
  MessageData,
  makeCastAdd,
  makeMessageHash,
  NobleEd25519Signer,
  SignatureScheme,
} from "@farcaster/core";
import { afterEach } from "vitest";
import { createMockNode, FIRST_AUTHOR, fixtureKey, ME_FID, type MockNode } from "../src/index.js";

export const SEED = 42;
export const ME = ME_FID;
export const AUTHOR = FIRST_AUTHOR;

const nodes: MockNode[] = [];
afterEach(async () => {
  await Promise.all(nodes.splice(0).map((n) => n.close()));
});

export async function startNode(): Promise<MockNode> {
  const node = await createMockNode({ fixtures: "basic" });
  nodes.push(node);
  return node;
}

export function authorSigner(fid = AUTHOR): NobleEd25519Signer {
  return new NobleEd25519Signer(fixtureKey(SEED, fid));
}

export async function castBy(
  signer: NobleEd25519Signer,
  text = "hello",
  fid = AUTHOR,
): Promise<Message> {
  const body = {
    text,
    type: CastType.CAST,
    embeds: [],
    embedsDeprecated: [],
    mentions: [],
    mentionsPositions: [],
  };
  const result = await makeCastAdd(body, { fid, network: FarcasterNetwork.MAINNET }, signer);
  return result._unsafeUnwrap();
}

export async function getJson(
  node: MockNode,
  path: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${node.url}${path}`);
  return { status: res.status, body: await res.json() };
}

export async function submit(
  node: MockNode,
  message: Message,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${node.url}/v1/submitMessage`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: Message.encode(message).finish(),
  });
  return { status: res.status, body: await res.json() };
}

/** Edits a message's data and re-hashes and re-signs it, bypassing the builders' validation. */
export async function resign(
  message: Message,
  signer: NobleEd25519Signer,
  edit: (data: MessageData) => void,
): Promise<Message> {
  const data = MessageData.decode(MessageData.encode(message.data as MessageData).finish());
  edit(data);
  const hash = (await makeMessageHash(data))._unsafeUnwrap();
  const signature = (await signer.signMessageHash(hash))._unsafeUnwrap();
  return Message.create({
    data,
    hash,
    hashScheme: HashScheme.BLAKE3,
    signature,
    signatureScheme: SignatureScheme.ED25519,
    signer: (await signer.getSignerKey())._unsafeUnwrap(),
    dataBytes: MessageData.encode(data).finish(),
  });
}
