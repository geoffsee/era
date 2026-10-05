// Declare the binding import without introducing Worker globals into the Bun/Node CLI types.
declare module "cloudflare:workers" {
    export const env: import("./configuration.ts").Env;
}
