import { after, before } from 'node:test';
import { chromium, Browser, Page, Route } from 'playwright';

// Tests drive a real headless Chromium, but every request to www.instagram.com is answered locally from
// the fixtures below and everything else is aborted - no network, no Instagram account involved.

let browser: Browser;

export function useBrowser(): void {
    before(async () => {
        browser = await chromium.launch({ headless: true });
    });
    after(async () => {
        await browser?.close();
    });
}

export type Respond = (route: Route, url: URL) => Promise<void>;

export async function offlinePage(respond: Respond): Promise<Page> {
    const context = await browser.newContext({ locale: 'en-US' });
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'www.instagram.com') return route.abort();
        await respond(route, url);
    });
    return context.newPage();
}

export const htmlPage = (body: string, head = '') =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Instagram</title>${head}</head><body>${body}</body></html>`;

export const serveHtml = (route: Route, body: string, status = 200) =>
    route.fulfill({ status, contentType: 'text/html; charset=utf-8', body });

export const LOGIN_ENDPOINT = '/api/v1/web/accounts/login/ajax/';

// Shared behaviour of both login-form variants: the submit control stays disabled until both fields
// have text, and a submit POSTs the credentials, then follows `next` or shows Instagram's error text.
const loginScript = (user: string, pass: string, button: string) => `<script>
    const u = document.querySelector('${user}'), p = document.querySelector('${pass}'), b = document.querySelector('${button}');
    const form = document.querySelector('form');
    const sync = () => {
        const ready = Boolean(u.value && p.value);
        if (b.tagName === 'BUTTON') b.disabled = !ready;
        else if (ready) b.removeAttribute('aria-disabled');
        else b.setAttribute('aria-disabled', 'true');
    };
    u.addEventListener('input', sync);
    p.addEventListener('input', sync);
    form.addEventListener('submit', e => e.preventDefault());
    b.addEventListener('click', async () => {
        if (b.disabled || b.getAttribute('aria-disabled') === 'true') return;
        const body = new URLSearchParams({ username: u.value, password: p.value });
        const res = await (await fetch('${LOGIN_ENDPOINT}', { method: 'POST', body })).json();
        if (!res.error) return void (location.href = res.next);
        const alert = document.createElement('div');
        alert.textContent = res.error;
        form.append(alert);
    });
</script>`;

// Structure copied from the live page on 2026-10-12: form#login_form, inputs name=email / name=pass with
// <label for>, and a div[role=button] whose accessible name is "Log In" while its text reads "Log in".
export const LOGIN_FORM_2026 = `
<div><span>Log into Instagram</span>
<form id="login_form" method="post">
    <label for="_r_4_">Mobile number, username or email</label>
    <input id="_r_4_" name="email" type="text" autocomplete="username webauthn">
    <label for="_r_7_">Password</label>
    <input id="_r_7_" name="pass" type="password">
    <div aria-label="Log In" role="button" tabindex="0" aria-disabled="true">Log in</div>
    <input type="submit" style="display:none">
    <a href="/accounts/password/reset/">Forgot password?</a>
    <div role="button" tabindex="0">Log in with Facebook</div>
    <a href="/accounts/emailsignup/">Create new account</a>
</form></div>
${loginScript('[name=email]', '[name=pass]', '[aria-label="Log In"]')}`;

// The pre-redesign form the original bot was written against.
export const LOGIN_FORM_LEGACY = `
<form id="loginForm" method="post">
    <input aria-label="Phone number, username, or email" name="username" type="text">
    <input aria-label="Password" name="password" type="password">
    <button type="submit" disabled>Log in</button>
</form>
${loginScript('[name=username]', '[name=password]', 'button[type=submit]')}`;

export const HOME_FEED = `
<nav><a href="/"><svg aria-label="Home" role="img" width="24" height="24"></svg> Home</a>
<a href="/direct/inbox/">Messages</a></nav><main><article>Feed</article></main>`;

export const TWO_FACTOR_PAGE = `
<form><h2>Enter security code</h2><p>Enter the 6-digit code we sent to your phone.</p>
<input name="verificationCode" aria-label="Security Code"><button>Confirm</button></form>`;

export const CHALLENGE_PAGE = `<main><h2>Help us confirm it's you</h2><p>We detected an unusual login attempt.</p></main>`;

export const SAVE_LOGIN_INFO_PAGE = `<main><h2>Save your login info?</h2><button>Save info</button><button>Not now</button></main>`;

export const consentDialogOver = (page: string) => `
<div role="dialog" id="consent"><h2>Allow the use of cookies from Instagram by this browser?</h2>
<button onclick="choose('allow')">Allow all cookies</button>
<button onclick="choose('decline')">Decline optional cookies</button></div>
<script>function choose(c) { fetch('/consent?choice=' + c); document.getElementById('consent').remove(); }</script>
${page}`;

/**
 * A stand-in for instagram.com's auth pages. `pages` maps a path to its body and may be changed
 * mid-test (e.g. flip "/" to the feed after login). Credential POSTs and consent choices are recorded.
 */
export function fakeAuthSite(
    pages: Record<string, string>,
    onLogin: (form: URLSearchParams) => { next?: string; error?: string } = () => ({ next: '/' })
) {
    const logins: URLSearchParams[] = [];
    const consent: string[] = [];
    const respond: Respond = async (route, url) => {
        if (url.pathname === LOGIN_ENDPOINT) {
            const form = new URLSearchParams(route.request().postData() ?? '');
            logins.push(form);
            return route.fulfill({ json: onLogin(form) });
        }
        if (url.pathname === '/consent') {
            consent.push(url.searchParams.get('choice') ?? '');
            return route.fulfill({ body: '' });
        }
        const body = pages[url.pathname];
        if (body === undefined) return serveHtml(route, htmlPage('<h2>Not found</h2>'), 404);
        return serveHtml(route, htmlPage(body));
    };
    return { respond, logins, consent, pages };
}
