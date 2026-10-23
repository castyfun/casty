import type { NodeMessage } from "../node/http.js";
import type { AppLabel } from "./render.js";

export interface CastFilterOptions {
  replies: boolean;
  /** Farcaster timestamp; older casts are dropped. */
  since?: number | undefined;
  channel?: string | undefined;
}

/** Filters that need nothing but the cast itself, applied before anything is resolved. */
export function castFilter({
  replies,
  since,
  channel,
}: CastFilterOptions): (cast: NodeMessage) => boolean {
  return (cast) => {
    const body = cast.data.castAddBody;
    if (!replies && body?.parentCastId) return false;
    if (since !== undefined && cast.data.timestamp < since) return false;
    if (channel !== undefined && body?.parentUrl !== channel) return false;
    return true;
  };
}

/** `ref` is an app's fid, its username, or its @username. */
export function matchesApp(ref: string, app: AppLabel | null): boolean {
  if (!app) return false;
  if (/^\d+$/.test(ref)) return app.fid === Number(ref);
  return app.name === ref.replace(/^@/, "");
}
