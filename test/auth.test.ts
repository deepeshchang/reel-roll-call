import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPage, detectAuthState, ensureLoggedIn, loginLocators } from '../src/auth';
import { BotError, ErrorCategory } from '../src/logger';
import {
    CHALLENGE_PAGE,
    consentDialogOver,
    fakeAuthSite,
    HOME_FEED,
    htmlPage,
    LOGIN_FORM_2026,
    LOGIN_FORM_LEGACY,
    offlinePage,
    SAVE_LOGIN_INFO_PAGE,
    serveHtml,
    TWO_FACTOR_PAGE,
    useBrowser,
} from './helpers';

useBrowser();

const HOME = 'https://www.instagram.com/?hl=en';
const creds = { username: 'test_account', password: 'test-password-123', timeoutMs: 3000 };

async function rejectsWith(promise: Promise<unknown>, category: ErrorCategory): Promise<BotError> {
    try {
        await promise;
    } catch (e) {
        assert.ok(e instanceof BotError, `expected a BotError, got: ${e}`);
        assert.equal(e.category, category, e.message);
        return e;
    }
    return assert.fail(`expected a ${category} error, but it resolved`);
}

describe('login form locators', () => {
    test('recognise the 2026 form (name=email/pass, "Log In" div button)', async () => {
        const page = await offlinePage(fakeAuthSite({ '/': LOGIN_FORM_2026 }).respond);
        await page.goto(HOME);
        assert.equal(await classifyPage(page), 'login_form');
        assert.equal(await loginLocators(page).username.getAttribute('name'), 'email');
    });

    test('still recognise the legacy form (name=username/password)', async () => {
        const page = await offlinePage(fakeAuthSite({ '/': LOGIN_FORM_LEGACY }).respond);
        await page.goto(HOME);
        assert.equal(await classifyPage(page), 'login_form');
        assert.equal(await loginLocators(page).username.getAttribute('name'), 'username');
    });
});

describe('ensureLoggedIn', () => {
    test('fills the 2026 form once with the configured credentials and returns when the feed loads', async () => {
        const site = fakeAuthSite({ '/': LOGIN_FORM_2026 }, () => {
            site.pages['/'] = HOME_FEED;
            return { next: '/' };
        });
        await ensureLoggedIn(await offlinePage(site.respond), creds);
        assert.equal(site.logins.length, 1);
        assert.equal(site.logins[0].get('username'), 'test_account');
        assert.equal(site.logins[0].get('password'), 'test-password-123');
    });

    test('logs in through the legacy form too', async () => {
        const site = fakeAuthSite({ '/': LOGIN_FORM_LEGACY }, () => {
            site.pages['/'] = HOME_FEED;
            return { next: '/' };
        });
        await ensureLoggedIn(await offlinePage(site.respond), creds);
        assert.equal(site.logins.length, 1);
    });

    test('waits through a slow client-side redirect to the login page, then logs in', async () => {
        const site = fakeAuthSite(
            {
                '/': `<p>Loading…</p><script>setTimeout(() => location.replace('/accounts/login/?next=%2F'), 1200)</script>`,
                '/accounts/login/': LOGIN_FORM_2026,
            },
            () => {
                site.pages['/'] = HOME_FEED;
                return { next: '/' };
            }
        );
        await ensureLoggedIn(await offlinePage(site.respond), creds);
        assert.equal(site.logins.length, 1);
    });

    test('declines optional cookies in a consent dialog, then logs in', async () => {
        const site = fakeAuthSite({ '/': consentDialogOver(LOGIN_FORM_2026) }, () => {
            site.pages['/'] = HOME_FEED;
            return { next: '/' };
        });
        await ensureLoggedIn(await offlinePage(site.respond), creds);
        assert.deepEqual(site.consent, ['decline']);
        assert.equal(site.logins.length, 1);
    });

    test('treats the post-login "Save your login info?" page as logged in', async () => {
        const site = fakeAuthSite({ '/': LOGIN_FORM_2026, '/accounts/onetap/': SAVE_LOGIN_INFO_PAGE }, () => ({
            next: '/accounts/onetap/?next=%2F',
        }));
        await ensureLoggedIn(await offlinePage(site.respond), creds);
        assert.equal(site.logins.length, 1);
    });

    test('stops at two-factor after a single submission when no person is available', async () => {
        const site = fakeAuthSite({ '/': LOGIN_FORM_2026, '/accounts/login/two_factor': TWO_FACTOR_PAGE }, () => ({
            next: '/accounts/login/two_factor?next=%2F',
        }));
        const err = await rejectsWith(ensureLoggedIn(await offlinePage(site.respond), creds), 'TWO_FACTOR');
        assert.match(err.message, /npm run login/);
        assert.equal(site.logins.length, 1);
    });

    test('never types credentials into a security checkpoint', async () => {
        const site = fakeAuthSite({
            '/': `<script>location.replace('/challenge/AbC123/')</script>`,
            '/challenge/AbC123/': CHALLENGE_PAGE,
        });
        await rejectsWith(ensureLoggedIn(await offlinePage(site.respond), creds), 'CHECKPOINT');
        assert.equal(site.logins.length, 0);
    });

    test('in a visible browser, waits for the person to clear a checkpoint, then continues', async () => {
        const site = fakeAuthSite({
            '/': `<script>location.replace('/challenge/AbC123/')</script>`,
            '/challenge/AbC123/': CHALLENGE_PAGE,
        });
        const page = await offlinePage(site.respond);
        const prompts: string[] = [];
        await ensureLoggedIn(page, {
            ...creds,
            waitForHuman: async instructions => {
                prompts.push(instructions);
                site.pages['/'] = HOME_FEED; // the person solved it and Instagram moved on to the feed
                await page.goto(HOME);
            },
        });
        assert.equal(prompts.length, 1);
        assert.match(prompts[0], /browser window/);
        assert.equal(site.logins.length, 0);
    });

    test('in a visible browser, carries on by itself once the person clears the check (no Enter needed)', { timeout: 15000 }, async () => {
        const site = fakeAuthSite({
            '/': `<script>location.replace('/challenge/AbC123/')</script>`,
            '/challenge/AbC123/': CHALLENGE_PAGE,
        });
        const page = await offlinePage(site.respond);
        let promptCancelled = false;
        setTimeout(() => {
            site.pages['/'] = HOME_FEED; // the person finishes the check in the browser window...
            void page.goto(HOME);
        }, 1000);
        await ensureLoggedIn(page, {
            ...creds,
            // ...and never touches the terminal: this prompt only ends when the bot cancels it.
            waitForHuman: (_instructions, pageMovedOn) =>
                new Promise<void>(resolve =>
                    pageMovedOn.addEventListener('abort', () => {
                        promptCancelled = true;
                        resolve();
                    })
                ),
        });
        assert.ok(promptCancelled, 'the Enter prompt should be cancelled once the page moved on');
        assert.equal(site.logins.length, 0);
    });

    test("reports a rejected password with Instagram's message and does not retry", async () => {
        const site = fakeAuthSite({ '/': LOGIN_FORM_2026 }, () => ({
            error: 'Sorry, your password was incorrect. Please double-check your password.',
        }));
        const err = await rejectsWith(ensureLoggedIn(await offlinePage(site.respond), creds), 'AUTH_REJECTED');
        assert.match(err.message, /password was incorrect/);
        assert.equal(site.logins.length, 1);
    });

    test('does not re-submit when the login form silently comes back', async () => {
        const site = fakeAuthSite({ '/': LOGIN_FORM_2026 }, () => ({ next: '/' })); // "/" still shows the form
        const page = await offlinePage(site.respond);
        await rejectsWith(ensureLoggedIn(page, { ...creds, timeoutMs: 1500 }), 'AUTH_REJECTED');
        assert.equal(site.logins.length, 1);
    });

    test('stops on a rate-limit message without retrying', async () => {
        const site = fakeAuthSite({ '/': LOGIN_FORM_2026 }, () => ({ error: 'Please wait a few minutes before you try again.' }));
        await rejectsWith(ensureLoggedIn(await offlinePage(site.respond), creds), 'RATE_LIMITED');
        assert.equal(site.logins.length, 1);
    });

    test('asks for a person when a login is needed but no password is configured', async () => {
        const site = fakeAuthSite({ '/': LOGIN_FORM_2026 });
        const page = await offlinePage(site.respond);
        await rejectsWith(ensureLoggedIn(page, { username: 'test_account', timeoutMs: 3000 }), 'AUTH_REQUIRED');
        assert.equal(site.logins.length, 0);
    });

    test('refuses to fill anything on an unrecognised page and gives up at the timeout', async () => {
        const site = fakeAuthSite({ '/': '<h1>Something unexpected</h1><input id="search" placeholder="Search">' });
        const page = await offlinePage(site.respond);
        const started = Date.now();
        await rejectsWith(ensureLoggedIn(page, { ...creds, timeoutMs: 800 }), 'UNKNOWN_PAGE');
        assert.ok(Date.now() - started < 5000, 'should give up shortly after the timeout');
        assert.equal(await page.locator('#search').inputValue(), '');
        assert.equal(site.logins.length, 0);
    });

    test('reports NETWORK when Instagram cannot be reached', async () => {
        const page = await offlinePage(route => route.abort('internetdisconnected'));
        await rejectsWith(ensureLoggedIn(page, creds), 'NETWORK');
    });
});

describe('detectAuthState', () => {
    test('returns "unknown" once the timeout passes with nothing recognisable on screen', async () => {
        const page = await offlinePage(route => serveHtml(route, htmlPage('<p>Loading…</p>')));
        await page.goto(HOME);
        const started = Date.now();
        assert.equal(await detectAuthState(page, 600), 'unknown');
        const elapsed = Date.now() - started;
        assert.ok(elapsed >= 600 && elapsed < 3000, `took ${elapsed}ms`);
    });
});
