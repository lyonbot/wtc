export function findLocalWtc(o: { argv: string[]; env: Record<string, string | undefined>; cwd: string; selfVersion: string }): { entry: string; version: string } | undefined;
export function runForwarded(runner: string, entry: string, argv: string[], env: Record<string, string | undefined>): Promise<number | undefined>;
