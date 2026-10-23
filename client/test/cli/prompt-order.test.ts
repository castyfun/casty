import { expect, it, vi } from "vitest";
import { startMock } from "../mock.js";
import { casty, flags, initMe, tempConfig } from "./harness.js";

// The signing code loads only once the gate opens, which the passphrase prompt does: a command
// that waited for that code before asking would never ask.
const gate = vi.hoisted(() => {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
});
vi.mock("../../src/submit/actions.js", async (importOriginal) => {
  await gate.opened;
  return importOriginal();
});

it("asks for the passphrase while the code that signs is still loading", async () => {
  const node = await startMock();
  const dir = tempConfig();
  expect((await initMe(node.url, dir)).code).toBe(0);
  const prompt = async () => {
    gate.open();
    return new TextEncoder().encode("x");
  };
  const { code } = await casty(["cast", "typed while it loads", ...flags(node.url, dir)], {
    prompt,
  });
  expect(code).toBe(0);
  expect(node.state.casts.some((c) => c.data.castAddBody?.text === "typed while it loads")).toBe(
    true,
  );
}, 5000);
