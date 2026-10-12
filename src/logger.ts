import chalk from 'chalk';
import * as fs from 'fs';

/** Failure stages, so a log line says *where* things went wrong. */
export type ErrorCategory =
    | 'CONFIG'
    | 'INPUT'
    | 'NETWORK'
    | 'AUTH_REQUIRED'
    | 'AUTH_REJECTED'
    | 'SESSION_EXPIRED'
    | 'TWO_FACTOR'
    | 'CHECKPOINT'
    | 'RATE_LIMITED'
    | 'UNKNOWN_PAGE'
    | 'UNAVAILABLE'
    | 'PRIVATE'
    | 'COMMENT_FAILED'
    | 'AI';

export class BotError extends Error {
    readonly category: ErrorCategory;

    constructor(category: ErrorCategory, message: string) {
        super(message);
        this.name = 'BotError';
        this.category = category;
    }
}

const secrets = new Set<string>();

/** Register a value (password, API key) that must never reach the console or the log file. */
export function registerSecret(value: string | undefined): void {
    if (value && value.length >= 4) secrets.add(value);
}

export function redact(text: string): string {
    let out = text;
    for (const secret of secrets) out = out.split(secret).join('***');
    return out;
}

export class Logger {
    /** When set, every line is also appended here as one JSON object per line (JSONL). */
    static file: string | undefined;

    private readonly accountUsername: string;

    constructor(accountUsername: string = 'SYSTEM') {
        this.accountUsername = accountUsername;
    }

    private getTimestamp(): string {
        return `[${new Date().toLocaleTimeString()}]`;
    }

    private getPrefix(): string {
        return chalk.bold.cyan(`[${this.accountUsername}]`);
    }

    private emit(level: string, paint: (text: string) => string, message: string, category?: ErrorCategory): void {
        const text = redact(category ? `[${category}] ${message}` : message);
        const line = `${chalk.gray(this.getTimestamp())} ${this.getPrefix()} ${paint(text)}`;
        if (level === 'error') console.error(line);
        else console.log(line);

        if (!Logger.file) return;
        const entry = { ts: new Date().toISOString(), level, scope: this.accountUsername, category, message: redact(message) };
        try {
            fs.appendFileSync(Logger.file, JSON.stringify(entry) + '\n');
        } catch {
            // Logging must never take the bot down.
        }
    }

    public info(message: string): void {
        this.emit('info', text => text, message);
    }

    public action(message: string): void {
        this.emit('info', chalk.blueBright, message);
    }

    public success(message: string): void {
        this.emit('info', chalk.greenBright, message);
    }

    public error(message: string, category?: ErrorCategory): void {
        this.emit('error', chalk.redBright, message, category);
    }

    public warn(message: string, category?: ErrorCategory): void {
        this.emit('warn', chalk.yellowBright, message, category);
    }

    public debug(message: string): void {
        this.emit('debug', chalk.gray.italic, message);
    }

    public header(message: string): void {
        console.log(chalk.bold.magentaBright(`\n${message}`));
    }
}
