/** An error the CLI prints as one line plus an optional hint, then exits with `exitCode`. */
export class CastyError extends Error {
  readonly exitCode: number;
  readonly hint: string | undefined;

  constructor(message: string, exitCode: number, hint?: string) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

/** Bad flags or arguments. Exit code 2. */
export class UsageError extends CastyError {
  constructor(message: string, hint?: string) {
    super(message, 2, hint);
  }
}

/** Missing or unreadable config, key store or seed phrase. Exit code 5. */
export class ConfigError extends CastyError {
  constructor(message: string, hint?: string) {
    super(message, 5, hint);
  }
}
