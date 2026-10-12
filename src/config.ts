import * as fs from 'fs';
import * as path from 'path';

// Secrets and per-user settings come from the environment. A local .env file (gitignored) is loaded
// if present; variables already set in the shell win over .env. See .env.example for every setting.
const rootDir = path.join(__dirname, '..');
const envFile = path.join(rootDir, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;

function positiveInt(name: string, fallback: number): number {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive whole number (got "${raw}").`);
    }
    return value;
}

const list = (raw: string | undefined) =>
    (raw ?? '').split(',').map(item => item.trim()).filter(Boolean);

const username = (env.IG_USERNAME ?? '').trim();
export const dataDir = path.join(rootDir, 'data');
export const logsDir = path.join(dataDir, 'logs');

export const config = {
    username,
    /** Optional. Without it, log in by hand in the visible browser that `npm run login` opens. */
    password: env.IG_PASSWORD || undefined,
    geminiApiKey: env.GEMINI_API_KEY || undefined,
    geminiModel: env.GEMINI_MODEL || 'gemini-flash-lite-latest',
    aiPromptHint: env.AI_PROMPT_HINT || undefined,
    /** Fail-safe: anything other than the literal "false" keeps dry-run on. */
    dryRun: env.DRY_RUN !== 'false',
    headless: env.HEADLESS !== 'false',
    /** Max reels opened (and drafted) per calendar day. */
    dailyLimit: positiveInt('DAILY_LIMIT', 20),
    /** Minimum gap between page loads on Instagram - conservative pacing, not evasion. */
    actionDelaySeconds: positiveInt('ACTION_DELAY_SECONDS', 30),
    /** Group chats (chat links) whose reels of the day `npm run add` and `npm run auto` read. */
    groupChats: list(env.GROUP_CHATS),
    /** Minimum gap between two posted comments, also across runs. */
    commentGapSeconds: positiveInt('COMMENT_GAP_SECONDS', 90),
    /** `npm run auto` comments at most this many times a day on posts by the same account. */
    authorDailyLimit: positiveInt('AUTHOR_DAILY_LIMIT', 2),
    /** DM conversations (export folder names or titles) explicitly authorised for import. */
    authorizedThreads: list(env.AUTHORIZED_THREADS),
    sessionFile: path.join(dataDir, 'cookies', `${username.replace(/[^A-Za-z0-9._@+-]/g, '_') || 'default'}.json`),
    dbFile: path.join(dataDir, 'reels.db'),
};
