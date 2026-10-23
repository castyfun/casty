import { Message } from "@farcaster/core";
import { bytesToHex } from "viem";
import { NodeError, NodeUnreachableError, NotMergedError } from "../node/errors.js";
import type { NodeClient, NodeMessage } from "../node/http.js";

export interface ConfirmOptions {
  timeoutMs?: number;
  pollMs?: number;
  /** How many times to send the same message again if it does not merge in time. */
  resubmit?: number;
}

const RELAY_HINT =
  "a read node keeps nothing: HTTP 200 means it checked the message and passed it on to " +
  "validators, which can drop it. It may still merge, so look for it before trying again: " +
  "running the command again sends a new message.";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One look for the message. A look that fails (a busy or unreachable node) says nothing about
 * the message, which the node has already taken: it counts as not merged yet, not as a failed
 * write, or the caller would forget a key or post a cast again that may still land.
 */
const merged = (confirm: () => Promise<boolean>) => confirm().catch(() => false);

async function poll(
  confirm: () => Promise<boolean>,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await merged(confirm)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollMs);
  }
}

/**
 * Submits `message` and waits until `confirm()` sees it merged. A read node only relays, so a
 * message that does not merge in time is sent again (same bytes, same hash) before giving up.
 * Node rejections (non-2xx) are thrown as mapped NodeErrors and never resubmitted; a refused
 * resubmit counts as success when the first copy has merged by then.
 */
export async function submitAndConfirm(
  node: NodeClient,
  message: Message,
  confirm: () => Promise<boolean>,
  { timeoutMs = 20_000, pollMs = 500, resubmit = 1 }: ConfirmOptions = {},
): Promise<NodeMessage> {
  const bytes = Message.encode(message).finish();
  const accepted = await node.submitMessage(bytes);
  for (let attempt = 0; ; attempt++) {
    if (await poll(confirm, timeoutMs, pollMs)) return accepted;
    if (attempt >= resubmit) break;
    try {
      await node.submitMessage(bytes);
    } catch (error) {
      if (!(error instanceof NodeError || error instanceof NodeUnreachableError)) throw error;
      // The first copy may have merged since the last look, and the node then refuses this one;
      // if it has not, the first copy is still out there, so this is "not merged", not a refusal.
      // A node gone by now is the same: a rerun would post a second cast with a new timestamp.
      if (await merged(confirm)) return accepted;
      break;
    }
  }
  const seconds = Math.round(((resubmit + 1) * timeoutMs) / 1000);
  throw new NotMergedError(
    `${bytesToHex(message.hash)} was accepted but not merged within ${seconds}s`,
    {
      hint: RELAY_HINT,
    },
  );
}
