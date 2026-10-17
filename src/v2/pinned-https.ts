import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type PinnedRequest = (url: URL, address: ResolvedAddress, signal: AbortSignal, maxBytes: number) => Promise<Response>;

const MAX_HEADER_BYTES = 32 * 1024;
const MAX_WIRE_BYTES_OVERHEAD = 512 * 1024;

function ipv4Number(address: string): number | undefined {
  if (!net.isIPv4(address)) return undefined;
  return address.split(".").reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
}

function inV4Range(address: string, base: string, bits: number): boolean {
  const value = ipv4Number(address); const network = ipv4Number(base);
  if (value === undefined || network === undefined) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (network & mask);
}

function ipv6Number(address: string): bigint | undefined {
  if (!net.isIPv6(address) || address.includes("%")) return undefined;
  let input = address.toLowerCase();
  const v4Tail = input.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Tail) {
    const v4 = ipv4Number(v4Tail[1]!);
    if (v4 === undefined) return undefined;
    input = input.slice(0, -v4Tail[1]!.length) + `${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  return groups.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}

function inV6Range(value: bigint, base: bigint, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return (value >> shift) === (base >> shift);
}

/** Reject IANA special-use IPv4 ranges and anything outside IPv6 global unicast. */
export function isDisallowedAddress(address: string): boolean {
  const v4 = ipv4Number(address);
  if (v4 !== undefined) {
    return [
      ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
      ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
      ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
      ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
    ].some(([base, bits]) => inV4Range(address, base as string, bits as number));
  }
  const v6 = ipv6Number(address);
  if (v6 === undefined) return true;
  // IPv4-mapped IPv6 must inherit the embedded IPv4 address policy.
  if ((v6 >> 32n) === 0xffffn) {
    const mapped = Number(v6 & 0xffffffffn);
    return isDisallowedAddress(`${mapped >>> 24}.${(mapped >>> 16) & 255}.${(mapped >>> 8) & 255}.${mapped & 255}`);
  }
  // Only global unicast (2000::/3) is eligible. Exclude special-use and transition ranges.
  return !inV6Range(v6, 0x20000000000000000000000000000000n, 3)
    || inV6Range(v6, 0x20010000000000000000000000000000n, 23) // IETF protocol assignments
    || inV6Range(v6, 0x20010db8000000000000000000000000n, 32) // documentation prefix
    || inV6Range(v6, 0x20020000000000000000000000000000n, 16) // 6to4 embeds IPv4
    || inV6Range(v6, 0x3fff0000000000000000000000000000n, 20); // documentation prefix
}

export async function resolvePublicAddresses(hostname: string): Promise<ResolvedAddress[]> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const family = net.isIP(host);
  if (family) return [{ address: host, family: family as 4 | 6 }];
  const answers = await Promise.all([
    dns.resolve4(host).then((items) => items.map((address) => ({ address, family: 4 as const }))).catch(() => []),
    dns.resolve6(host).then((items) => items.map((address) => ({ address, family: 6 as const }))).catch(() => []),
  ]);
  const records = answers.flat();
  if (records.length === 0 || records.some((record) => isDisallowedAddress(record.address))) throw new Error("destination_not_public");
  return records;
}

function decodeChunked(input: Uint8Array, maxBytes: number): Uint8Array {
  let cursor = 0; const chunks: Uint8Array[] = []; let total = 0;
  const readLine = (): string => {
    let end = cursor;
    while (end + 1 < input.length && !(input[end] === 13 && input[end + 1] === 10)) end++;
    if (end + 1 >= input.length) throw new Error("invalid_chunked_body");
    const line = new TextDecoder().decode(input.subarray(cursor, end)); cursor = end + 2; return line;
  };
  while (true) {
    const sizeText = readLine().split(";", 1)[0]?.trim() ?? "";
    if (!/^[0-9a-f]+$/i.test(sizeText)) throw new Error("invalid_chunked_body");
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isSafeInteger(size) || size < 0 || total + size > maxBytes || cursor + size + 2 > input.length) throw new Error("invalid_chunked_body");
    if (size === 0) {
      while (readLine() !== "") { /* Ignore bounded response trailers. */ }
      if (cursor !== input.length) throw new Error("invalid_chunked_body");
      break;
    }
    chunks.push(input.slice(cursor, cursor + size)); total += size; cursor += size;
    if (input[cursor] !== 13 || input[cursor + 1] !== 10) throw new Error("invalid_chunked_body");
    cursor += 2;
  }
  const output = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
  return output;
}

function parseHttpResponse(raw: Uint8Array, maxBytes: number): Response {
  let boundary = -1;
  for (let i = 0; i + 3 < raw.length; i++) if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) { boundary = i; break; }
  if (boundary < 0 || boundary > MAX_HEADER_BYTES) throw new Error("invalid_http_headers");
  const headerText = new TextDecoder("latin1").decode(raw.subarray(0, boundary));
  const lines = headerText.split("\r\n"); const match = lines.shift()?.match(/^HTTP\/1\.[01] (\d{3})(?: .*)?$/);
  if (!match) throw new Error("invalid_http_status");
  const status = Number(match[1]); if (status < 200 || status > 599) throw new Error("invalid_http_status");
  const headers = new Headers();
  for (const line of lines) {
    const colon = line.indexOf(":"); if (colon <= 0 || /^[ \t]/.test(line)) throw new Error("invalid_http_headers");
    const name = line.slice(0, colon).trim().toLowerCase(); const value = line.slice(colon + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || /[\r\n\0]/.test(value)) throw new Error("invalid_http_headers");
    if (["content-type", "content-length", "transfer-encoding", "location", "content-encoding"].includes(name)) headers.append(name, value);
  }
  const body = raw.subarray(boundary + 4);
  const encoding = headers.get("content-encoding"); if (encoding && encoding.toLowerCase() !== "identity") throw new Error("unsupported_content_encoding");
  let decoded: Uint8Array;
  if ([204, 304].includes(status)) decoded = new Uint8Array();
  else if ((headers.get("transfer-encoding") ?? "").toLowerCase() === "chunked") decoded = decodeChunked(body, maxBytes);
  else {
    const declared = headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes || Number(declared) !== body.length)) throw new Error("invalid_content_length");
    decoded = body;
  }
  if (decoded.byteLength > maxBytes) throw new Error("response_too_large");
  headers.delete("transfer-encoding"); headers.delete("content-encoding"); headers.set("content-length", String(decoded.byteLength));
  return new Response([204, 304].includes(status) ? null : Buffer.from(decoded), { status, headers });
}

function sameAddress(left: string, right: string): boolean {
  const leftV4 = ipv4Number(left); const rightV4 = ipv4Number(right);
  if (leftV4 !== undefined || rightV4 !== undefined) return leftV4 !== undefined && leftV4 === rightV4;
  const leftV6 = ipv6Number(left); const rightV6 = ipv6Number(right);
  return leftV6 !== undefined && leftV6 === rightV6;
}

/** Send one HTTPS request to a previously validated IP while verifying TLS for the URL hostname. */
type TlsConnector = typeof tls.connect;

export function createPinnedHttpsRequester(connect: TlsConnector = tls.connect): PinnedRequest {
  return (url, address, signal, maxBytes) => new Promise((resolve, reject) => {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || isDisallowedAddress(address.address)) return reject(new Error("unsafe_destination"));
  const target = `${url.pathname || "/"}${url.search}`;
  if (/[\r\n]/.test(target)) return reject(new Error("invalid_request_target"));
  let socket: ReturnType<typeof tls.connect>;
  try {
    socket = connect({ host: address.address, port: 443, ...(net.isIP(host) ? {} : { servername: host }), rejectUnauthorized: true });
  } catch (error) { reject(error); return; }
  const chunks: Uint8Array[] = []; let total = 0; let settled = false;
  const fail = (error: unknown) => { if (settled) return; settled = true; signal.removeEventListener("abort", abort); socket.destroy(); reject(error); };
  const abort = () => fail(new Error("request_aborted"));
  if (signal.aborted) { abort(); return; }
  signal.addEventListener("abort", abort, { once: true });
  socket.setTimeout(15_000, () => fail(new Error("request_timeout")));
  socket.once("error", fail);
  socket.once("secureConnect", () => {
    if (!socket.authorized || !socket.remoteAddress || !sameAddress(socket.remoteAddress, address.address)) return fail(new Error("pinned_connection_mismatch"));
    const hostHeader = url.host;
    socket.write(`GET ${target} HTTP/1.1\r\nHost: ${hostHeader}\r\nAccept: application/pdf, application/octet-stream;q=0.9\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`);
  });
  socket.on("data", (part: Uint8Array) => {
    total += part.byteLength;
    if (total > maxBytes + MAX_HEADER_BYTES + MAX_WIRE_BYTES_OVERHEAD) return fail(new Error("response_too_large"));
    chunks.push(new Uint8Array(part));
  });
  socket.once("end", () => {
    if (settled) return;
    try {
      const raw = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
      const response = parseHttpResponse(raw, maxBytes); settled = true; signal.removeEventListener("abort", abort); resolve(response);
    } catch (error) { fail(error); }
  });
  socket.once("close", () => { if (!settled) fail(new Error(chunks.length ? "truncated_response" : "empty_response")); });
  });
}

export const requestPinnedHttps = createPinnedHttpsRequester();
