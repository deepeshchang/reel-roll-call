import { Browser, chromium, Locator, Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { BotError, ErrorCategory, Logger } from './logger';

export type AuthState =
    | 'logged_in'
    | 'login_form'
    | 'login_error'
    | 'consent'
    | 'two_factor'
    | 'checkpoint'
    | 'rate_limited'
    | 'unknown';

const HOME_URL = 'https://www.instagram.com/?hl=en';

// URLs are checked first: cheapest and least ambiguous.
const TWO_FACTOR_URL = /two_factor|\/codeentry/i;
const CHECKPOINT_URL = /\/challenge\/|\/checkpoint\/|\/auth_platform\/|\/accounts\/(suspended|disabled)\//i;
const SAVE_LOGIN_INFO_URL = /\/accounts\/onetap\//i; // only ever shown right after a successful login

// Page text (English: pages are requested with hl=en and locale en-US).
export const RATE_LIMIT_TEXT = /wait a few minutes before you try again|try again later|we limit how often|restrict certain activity|too many requests/i;
const CHECKPOINT_TEXT = /suspicious login|unusual login|confirm it.s you|help us confirm|we suspended your account|account has been (disabled|suspended)/i;
const TWO_FACTOR_TEXT = /two-factor authentication|enter the (6-digit |security |confirmation |login )?code|check your (text messages|authentication app)/i;
const LOGIN_ERROR_TEXT = /password.{0,30}incorrect|incorrect password|login information.{0,30}incorrect|couldn.t find (your|an) account|isn.t connected to an account|problem logging you in/i;
const CONSENT_ESSENTIAL_ONLY = /^(decline optional cookies|only allow essential cookies)$/i;
const CONSENT_ANY = /^(decline optional cookies|only allow essential cookies|allow all cookies)$/i;

/**
 * Login-form controls. Covers the 2026 form (name=email / name=pass, a div button labelled "Log In")
 * and the older one (name=username / name=password, <button>Log in</button>), with the field label
 * as a fallback if the name attributes change again.
 */
export function loginLocators(page: Page) {
    return {
        username: page
            .locator('input[name="username"], input[name="email"]')
            .or(page.getByLabel(/username/i))
            .filter({ visible: true })
            .first(),
        password: page.locator('input[type="password"]').filter({ visible: true }).first(),
        submit: page.getByRole('button', { name: /^log in$/i }).first(),
    };
}

export const isVisible = (locator: Locator) =>
    locator
        .first()
        .isVisible()
        .catch(() => false); // the page may be mid-navigation

/** One look at the page. `null` means nothing recognisable has rendered yet. */
export async function classifyPage(page: Page): Promise<AuthState | null> {
    const url = page.url();
    if (TWO_FACTOR_URL.test(url)) return 'two_factor';
    if (CHECKPOINT_URL.test(url)) return 'checkpoint';
    if (SAVE_LOGIN_INFO_URL.test(url) || (await isVisible(page.locator('svg[aria-label="Home"], a[href^="/direct/inbox"]')))) {
        return 'logged_in';
    }
    if (await isVisible(page.locator('iframe[src*="captcha" i], iframe[title*="captcha" i], iframe[src*="arkoselabs"]'))) {
        return 'checkpoint';
    }
    if (await isVisible(page.getByText(RATE_LIMIT_TEXT))) return 'rate_limited';
    if (await isVisible(page.getByText(CHECKPOINT_TEXT))) return 'checkpoint';
    if ((await isVisible(page.getByText(TWO_FACTOR_TEXT))) || (await isVisible(page.locator('input[name="verificationCode"]')))) {
        return 'two_factor';
    }
    if (await isVisible(page.getByRole('button', { name: CONSENT_ANY }))) return 'consent';

    const form = loginLocators(page);
    if ((await isVisible(form.username)) && (await isVisible(form.password))) {
        return (await isVisible(page.getByText(LOGIN_ERROR_TEXT))) ? 'login_error' : 'login_form';
    }
    return null;
}

/**
 * Polls until the page settles into a recognisable state other than `ignore` (delayed rendering,
 * client-side redirects). On timeout - or when `signal` aborts - returns the last state seen, or
 * 'unknown' if there was none.
 */
export async function detectAuthState(page: Page, timeoutMs: number, ignore?: AuthState, signal?: AbortSignal): Promise<AuthState> {
    const deadline = Date.now() + timeoutMs;
    let last: AuthState = 'unknown';
    while (!signal?.aborted) {
        const state = await classifyPage(page).catch(() => null);
        if (state) {
            last = state;
            if (state !== ignore) return state;
        }
        if (Date.now() >= deadline) break;
        await sleep(250);
    }
    return last;
}

export interface LoginOptions {
    username: string;
    /** Optional: without it a person logs in by hand (visible browser only). */
    password?: string;
    /**
     * Visible-browser mode: called when a person has to act in the window (log in, enter a 2FA code,
     * clear a checkpoint). The login carries on as soon as the page moves on - `done` then aborts so a
     * pending "press Enter" prompt can be dropped - or when this resolves (the person pressed Enter).
     * Omit for headless runs: those stop with instructions instead.
     */
    waitForHuman?: (instructions: string, done: AbortSignal) => Promise<void>;
    /** How long to watch the page for a person before asking again (default 10 minutes). */
    humanTimeoutMs?: number;
    /** A saved session was loaded, so landing on the login form means it expired. */
    restoredSession?: boolean;
    timeoutMs?: number;
    logger?: Logger;
}

const humanSteps: Record<'login_form' | 'two_factor' | 'checkpoint', { category: ErrorCategory; what: string; todo: string }> = {
    login_form: { category: 'AUTH_REQUIRED', what: 'Instagram needs you to log in.', todo: 'Log in in the browser window.' },
    two_factor: {
        category: 'TWO_FACTOR',
        what: 'Instagram is asking for a two-factor / confirmation code.',
        todo: 'Enter the code in the browser window.',
    },
    checkpoint: {
        category: 'CHECKPOINT',
        what: 'Instagram is showing a security check (CAPTCHA or "confirm it\'s you").',
        todo: 'Complete it in the browser window.',
    },
};

/** Waits for a person to get the page past `current` (or to say they're done); never acts for them. */
async function askHuman(page: Page, opts: LoginOptions, step: keyof typeof humanSteps, current: AuthState): Promise<void> {
    const { what, todo } = humanSteps[step];
    let { category } = humanSteps[step];
    if (!opts.waitForHuman) {
        if (step === 'login_form' && opts.restoredSession) category = 'SESSION_EXPIRED';
        throw new BotError(
            category,
            `${what} This needs a person: run "npm run login" to open a visible browser, finish it there, and the session is saved for later runs.`
        );
    }
    const done = new AbortController();
    try {
        await Promise.race([
            opts.waitForHuman(`${what} ${todo} The bot never fills in codes or solves checks itself; it carries on once the page moves on.`, done.signal),
            detectAuthState(page, opts.humanTimeoutMs ?? 10 * 60_000, current, done.signal),
        ]);
    } finally {
        done.abort(); // stops whichever side is still waiting
    }
}

export const firstLine = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0];

/**
 * Brings the page to a logged-in Instagram session. Credentials are submitted at most once; anything
 * after that (2FA, checkpoint, rejection, rate limit, unknown page) stops or waits for a person - it
 * never re-submits.
 */
export async function ensureLoggedIn(page: Page, opts: LoginOptions): Promise<void> {
    const timeout = opts.timeoutMs ?? 30000;
    const log = opts.logger;
    try {
        await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout });
    } catch (e) {
        throw new BotError('NETWORK', `Could not load Instagram (${firstLine(e)}).`);
    }

    let submitted = false;
    let consentClicks = 0;
    let expiryNoted = false;
    let state = await detectAuthState(page, timeout);
    for (let step = 0; step < 8; step++) {
        log?.debug(`Login state: ${state}`);
        switch (state) {
            case 'logged_in':
                return;
            case 'rate_limited':
                throw new BotError('RATE_LIMITED', 'Instagram says to wait before trying again. Stopping now; retry in a few hours.');
            case 'login_error': {
                if (!submitted && opts.waitForHuman) {
                    await askHuman(page, opts, 'login_form', state); // the person typed it; let them try again
                    break;
                }
                const message = ((await page.getByText(LOGIN_ERROR_TEXT).first().textContent().catch(() => '')) ?? '').trim();
                throw new BotError(
                    'AUTH_REJECTED',
                    `Instagram rejected the login: "${message}". Not retrying - check IG_USERNAME / IG_PASSWORD, or log in by hand with "npm run login".`
                );
            }
            case 'consent':
                if (consentClicks++ >= 2) throw new BotError('UNKNOWN_PAGE', 'The cookie dialog keeps coming back.');
                log?.action('Cookie dialog: choosing essential cookies only.');
                await dismissConsent(page);
                break;
            case 'login_form':
                if (submitted) {
                    throw new BotError('AUTH_REJECTED', 'Still on the login form after submitting once. Not retrying, to avoid repeated logins.');
                }
                if (opts.restoredSession && !expiryNoted) {
                    expiryNoted = true;
                    log?.warn('The saved session has expired.', 'SESSION_EXPIRED');
                }
                if (!opts.password) {
                    await askHuman(page, opts, 'login_form', state);
                    break;
                }
                log?.action(`Submitting the login form for @${opts.username} (single attempt).`);
                await submitCredentials(page, opts.username, opts.password, timeout);
                submitted = true;
                state = await detectAuthState(page, timeout, 'login_form');
                continue;
            case 'two_factor':
            case 'checkpoint':
                await askHuman(page, opts, state, state);
                break;
            case 'unknown':
                throw new BotError('UNKNOWN_PAGE', `Unrecognised page at ${page.url()} - not entering credentials.`);
        }
        state = await detectAuthState(page, timeout);
    }
    throw new BotError('UNKNOWN_PAGE', 'Login did not finish after several steps.');
}

async function submitCredentials(page: Page, username: string, password: string, timeout: number): Promise<void> {
    const form = loginLocators(page);
    try {
        await form.username.fill(username, { timeout });
        await form.password.fill(password, { timeout });
        await form.submit.click({ timeout }); // waits until the button is enabled
    } catch (e) {
        throw new BotError('UNKNOWN_PAGE', `Could not use the login form (${firstLine(e)}). Nothing was submitted.`);
    }
}

async function dismissConsent(page: Page): Promise<void> {
    const essentialOnly = page.getByRole('button', { name: CONSENT_ESSENTIAL_ONLY });
    const button = (await isVisible(essentialOnly)) ? essentialOnly : page.getByRole('button', { name: CONSENT_ANY });
    await button.first().click({ timeout: 10000 });
}

export interface Session {
    browser: Browser;
    page: Page;
}

/**
 * Launches Chromium as-is (no fingerprint spoofing), restores the saved session if there is one,
 * makes sure it's logged in, and saves the session back owner-only (0600).
 */
export async function openSession(
    opts: LoginOptions & { headless: boolean; sessionFile: string; screenshotDir: string }
): Promise<Session> {
    const restoredSession = fs.existsSync(opts.sessionFile);
    opts.logger?.info(restoredSession ? 'Restoring saved session...' : 'No saved session yet.');
    const browser = await chromium.launch({ headless: opts.headless });
    try {
        const context = await browser.newContext({ storageState: restoredSession ? opts.sessionFile : undefined, locale: 'en-US' });
        const page = await context.newPage();
        try {
            await ensureLoggedIn(page, { ...opts, restoredSession });
        } catch (e) {
            const name = e instanceof BotError ? e.category.toLowerCase() : 'error';
            await page.screenshot({ path: path.join(opts.screenshotDir, `login_${name}.png`) }).catch(() => {});
            throw e;
        }
        fs.mkdirSync(path.dirname(opts.sessionFile), { recursive: true, mode: 0o700 });
        await context.storageState({ path: opts.sessionFile });
        fs.chmodSync(opts.sessionFile, 0o600);
        return { browser, page };
    } catch (e) {
        await browser.close();
        throw e;
    }
}
