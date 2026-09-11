/**
 * Connect-time SSRF guard.
 *
 * Checking a hostname's resolved addresses *before* connecting is not enough:
 * the check and the connection can resolve differently (DNS rebinding, a name
 * the public resolvers do not know but /etc/hosts or an internal DNS does). So
 * every outbound connection to a user-supplied host goes through
 * `guardedLookup`, which resolves with the same system resolver the socket
 * uses and refuses the connection if *any* returned address is not public.
 * IP literals never reach a lookup, so callers must still screen them with
 * `isPrivateHost` — which `validateUrl` and `assertPublicTarget` do.
 */

import { lookup as systemLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { Agent } from "undici";
import { DEFAULT_TIMEOUT_MS } from "../constants.js";
import { isPrivateHost, isPublicIp } from "./validate.js";

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

export type LookupFunction = (hostname: string, options: LookupOptions, callback: LookupCallback) => void;

export class SsrfError extends Error {
  readonly code = "ESSRF";
}

/** Build a `lookup` for net/tls/undici that only ever hands back public addresses. */
export function createGuardedLookup(resolve: typeof systemLookup = systemLookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, [], undefined);
      const list = addresses as unknown as LookupAddress[];
      const blocked = list.find((a) => !isPublicIp(a.address));
      if (list.length === 0 || blocked) {
        const reason = blocked ? `it resolves to ${blocked.address}` : "it has no address";
        return callback(
          new SsrfError(`Refusing to connect to ${hostname}: ${reason}, which is private or reserved.`),
          [],
          undefined,
        );
      }
      if (options.all) callback(null, list);
      else callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

export const guardedLookup = createGuardedLookup();

/** Throw if a host literal or name is obviously internal (the connect-time guard covers the rest). */
export function assertPublicTarget(host: string): void {
  if (isPrivateHost(host)) {
    throw new SsrfError(`Refusing to connect to ${host}: it is a private or reserved address.`);
  }
}

/** The dispatcher every outbound request uses: connections pass through `guardedLookup`. */
export const guardedDispatcher = new Agent({
  connect: { lookup: guardedLookup, timeout: DEFAULT_TIMEOUT_MS },
  headersTimeout: DEFAULT_TIMEOUT_MS,
  bodyTimeout: DEFAULT_TIMEOUT_MS,
});
