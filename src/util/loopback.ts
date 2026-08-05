/**
 * Whether `host` names a loopback address. Shared by the CLI's bind-time
 * caution (cli.ts) and the adapter's attach-mode termination guard
 * (adapter.ts) so the loopback set has one source of truth.
 */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}
