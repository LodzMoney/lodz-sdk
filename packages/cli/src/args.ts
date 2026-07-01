/**
 * Argument parsing. No dependency, and no silent coercion: an unparseable
 * value is an error, never a default. `--btc abc` becoming 0 and then printing
 * a confident 0.00000000 BTC is worse than refusing.
 */

export class CliUsageError extends Error {
  override readonly name = "CliUsageError";
  constructor(message: string) {
    super(message);
  }
}

export interface ParsedArgs {
  readonly command: string;
  readonly flags: Readonly<Record<string, string | boolean>>;
}

const KNOWN_BOOLEAN = new Set(["json", "help", "version", "no-color", "send", "verbose"]);

/**
 * Short aliases, normalised to their long form before dispatch.
 * `-h` and `-V` are what people actually type.
 */
const SHORT: Readonly<Record<string, string>> = { "-h": "--help", "-V": "--version" };

export function parseArgs(argv: readonly string[]): ParsedArgs {
  // An option in the command position is an option, not a command. Treating
  // `--help` as a command produced "Unknown command --help. Run lodz --help",
  // which tells the reader to run the thing they just ran.
  const normalised = argv.map((a) => SHORT[a] ?? a);
  const first = normalised[0];
  const commandIsOption = first !== undefined && first.startsWith("-");
  const command = commandIsOption ? "" : (first ?? "");
  const rest = commandIsOption ? normalised : normalised.slice(1);

  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === undefined) continue;
    if (!token.startsWith("--")) {
      throw new CliUsageError(`Unexpected argument ${JSON.stringify(token)}. Options start with --.`);
    }
    const body = token.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (KNOWN_BOOLEAN.has(body)) {
      flags[body] = true;
      continue;
    }
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new CliUsageError(`Option --${body} needs a value.`);
    }
    flags[body] = next;
    i += 1;
  }
  return { command, flags };
}

export function flagString(
  flags: Readonly<Record<string, string | boolean>>,
  name: string,
): string | undefined {
  const v = flags[name];
  if (v === undefined) return undefined;
  if (typeof v === "boolean") throw new CliUsageError(`Option --${name} needs a value.`);
  return v;
}

export function flagBool(flags: Readonly<Record<string, string | boolean>>, name: string): boolean {
  return flags[name] === true || flags[name] === "true";
}

/** Parse a positive decimal. Rejects NaN, zero, negatives and infinities. */
export function flagAmount(
  flags: Readonly<Record<string, string | boolean>>,
  name: string,
): number | undefined {
  const raw = flagString(flags, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new CliUsageError(`Option --${name} must be a number, got ${JSON.stringify(raw)}.`);
  }
  if (n <= 0) {
    throw new CliUsageError(`Option --${name} must be greater than zero, got ${raw}.`);
  }
  return n;
}

const STOPES = ["conservative", "balanced", "aggressive"] as const;
export type StopeName = (typeof STOPES)[number];

export function flagStope(
  flags: Readonly<Record<string, string | boolean>>,
  fallback: StopeName = "balanced",
): StopeName {
  const raw = flagString(flags, "stope");
  if (raw === undefined) return fallback;
  const hit = STOPES.find((s) => s === raw);
  if (!hit) {
    throw new CliUsageError(
      `Unknown --stope ${JSON.stringify(raw)}. Expected one of ${STOPES.join(", ")}.`,
    );
  }
  return hit;
}

const YIELD_TYPES = ["sustainable", "emissions", "counterparty"] as const;
export type YieldTypeName = (typeof YIELD_TYPES)[number];

export function flagYieldType(
  flags: Readonly<Record<string, string | boolean>>,
): YieldTypeName | undefined {
  const raw = flagString(flags, "type");
  if (raw === undefined) return undefined;
  const hit = YIELD_TYPES.find((t) => t === raw);
  if (!hit) {
    throw new CliUsageError(
      `Unknown --type ${JSON.stringify(raw)}. Expected one of ${YIELD_TYPES.join(", ")}.`,
    );
  }
  return hit;
}
