export function migrationNumericPrefix(filename: string): number {
  // Historical migrations may carry a letter suffix (for example, 014b_...).
  const match = /^(\d{3})[a-z]?_/i.exec(filename);
  if (!match) {
    throw new Error(`Migration filename must start with a three-digit numeric prefix: ${filename}`);
  }
  return Number(match[1]);
}

export function invalidNewMigrationNames(filenames: readonly string[]): string[] {
  return filenames.filter((filename) => !/^\d{3}_/.test(filename)).sort();
}

export function migrationsAtOrBelowBaseline(
  pendingMigrations: readonly string[],
  appliedBaselineMigrations: readonly string[],
): string[] {
  if (appliedBaselineMigrations.length === 0) {
    throw new Error("Migration ordering requires an applied target-branch baseline.");
  }
  const highestAppliedPrefix = Math.max(...appliedBaselineMigrations.map(migrationNumericPrefix));
  return pendingMigrations.filter((filename) => migrationNumericPrefix(filename) <= highestAppliedPrefix);
}

export function duplicateMigrationPrefixes(filenames: readonly string[]): string[] {
  const filesByPrefix = new Map<number, string[]>();
  for (const filename of filenames) {
    const prefix = migrationNumericPrefix(filename);
    filesByPrefix.set(prefix, [...(filesByPrefix.get(prefix) ?? []), filename]);
  }
  return [...filesByPrefix.values()]
    .filter((files) => files.length > 1)
    .flat()
    .sort();
}
