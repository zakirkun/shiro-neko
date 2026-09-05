/**
 * Single source of truth for the version.
 *
 * `bun build --compile` does not embed package.json, so reading it at runtime
 * fails inside the shipped binary. A constant is compiled in and always correct.
 * `scripts/release.ts` checks it against the release tag so the two cannot drift.
 */
export const VERSION = '0.1.0-beta.5';

/** What `--version` prints: enough to identify a build from a bug report. */
export function versionLine(): string {
  return [
    `shiro-neko ${VERSION}`,
    `bun ${Bun.version}`,
    `${process.platform}-${process.arch}`,
    import.meta.path.startsWith('/$bunfs/') || import.meta.path.includes('~BUN') ? 'compiled' : 'source',
  ].join('  ');
}
