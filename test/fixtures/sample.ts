export function decide(cmd: string): string {
  if (!cmd.startsWith('rm')) return 'allow';
  const cfg = { dryRun: true };
  return cfg.dryRun ? 'allow' : 'deny';
}