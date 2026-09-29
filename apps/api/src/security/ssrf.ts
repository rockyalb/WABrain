/**
 * The push-endpoint SSRF guard lives in @wabrain/notify, which also re-checks every endpoint
 * right before sending. Re-exported here for the API's registration route.
 */
export { UnsafeUrlError, assertSafePushEndpoint, isPrivateAddress, type Resolver } from "@wabrain/notify";
