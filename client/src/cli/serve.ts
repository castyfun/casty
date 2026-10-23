import type { Command } from "commander";
import type { Io } from "./context.js";
import { serveWeb, type WebFlags } from "./web.js";

/** Where casty serve listens: every interface of its container, for the proxy in front. */
const SERVE_LISTEN = "0.0.0.0:3390";

/**
 * The page as a service: casty web over an index of the feed that follows the node's events,
 * with push for mentions and a request limit, and, behind a proxy that ends HTTPS (Caddy, or
 * tailscale serve) on the node's host, the public host in its links and HSTS. 1-node.sh serve
 * installs it there.
 */
export function registerServe(program: Command, io: Io): void {
  program
    .command("serve")
    .description(
      "the page over an index of the feed, with push; on the node's host behind HTTPS, which 1-node.sh serve installs",
    )
    .option(
      "--public-host <domain>",
      "the domain the page is reached at through a proxy that ends HTTPS; it goes into the pairing link",
    )
    .option("--listen <host:port>", "where to serve, for the proxy", SERVE_LISTEN)
    .option("--new-token", "pair again; links printed before stop working")
    .option("--read-only", "do not unlock the app key; the page reads but cannot write")
    .option(
      "--no-allow-fname-server",
      "look @names up with your node only; by default names it does not know are looked up on fnames.farcaster.xyz (public, no key)",
    )
    .action((flags: WebFlags, command: Command) =>
      serveWeb({ ...flags, serve: true }, command, io),
    );
}
