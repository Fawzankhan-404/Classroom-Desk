declare module "cloudflare:workers" {
  export const env: unknown;
}

declare module "cloudflare:node" {
  export function httpServerHandler(options: { port: number }): { fetch: (...args: unknown[]) => Promise<Response> };
}
