// Type declarations for Cloudflare Workers environment
declare module "cloudflare:workers" {
  const env: Record<string, unknown>;
  export { env };
}
