import { Page } from 'playwright';
import { setTimeout as sleep } from 'timers/promises';
import { firstLine, isVisible } from './auth';
import { BotError } from './logger';

export type ReelInfo =
    | { status: 'ok'; author?: string; caption?: string; imageUrl?: string }
    | { status: 'unavailable' | 'private' };

const UNAVAILABLE_TEXT = /(post|page|reel) isn.t available|the link may be broken/i;
const PRIVATE_TEXT = /this account is private/i;

/** Author and caption from the server-rendered meta tags (present on every viewable post or reel). */
function parseMeta(meta: Record<string, string>): { author?: string; caption?: string; imageUrl?: string } {
    let author: string | undefined;
    try {
        // og:url is /<author>/reel/<code>/ on current pages.
        const [first, second] = new URL(meta['og:url']).pathname.split('/').filter(Boolean);
        if (/^(p|reels?|tv)$/.test(second ?? '')) author = first;
    } catch {
        // fall through to twitter:title
    }
    author ??= /\(@([A-Za-z0-9._]+)\)/.exec(meta['twitter:title'] ?? '')?.[1];
    const caption =
        /^.*? on Instagram: "([\s\S]*)"$/.exec(meta['og:title'] ?? '')?.[1] ?? /: "([\s\S]*)"\.?\s*$/.exec(meta['og:description'] ?? '')?.[1];
    return { author, caption: caption?.trim() || undefined, imageUrl: meta['og:image'] || undefined };
}

/** Throws when Instagram has sent the browser to its login page or a security check. */
export function assertNotBounced(url: string): void {
    if (/\/accounts\/login/.test(url)) {
        throw new BotError('SESSION_EXPIRED', 'Instagram sent the browser to its login page. Run "npm run login" to refresh the session.');
    }
    if (/\/challenge\/|\/checkpoint\/|two_factor|\/auth_platform\//.test(url)) {
        throw new BotError('CHECKPOINT', 'Instagram wants a security check. Run "npm run login" and complete it in the browser window.');
    }
}

/**
 * Opens a reel/post in the logged-in browser and reads what it is. Per-reel outcomes (private,
 * unavailable) are returned; problems that affect every reel (expired session, checkpoint, rate
 * limit, network, unrecognised page) are thrown so the run stops.
 */
export async function openReel(page: Page, url: string, timeoutMs = 30000): Promise<ReelInfo> {
    const target = new URL(url);
    // /reel/<code>/ opens the full-screen player, which has no comment box; /p/<code>/ shows the same media
    // in the post layout, with the comment panel.
    target.pathname = target.pathname.replace(/^\/reels?\//, '/p/');
    target.searchParams.set('hl', 'en');
    let response;
    try {
        response = await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    } catch (e) {
        throw new BotError('NETWORK', `Could not load ${url} (${firstLine(e)}).`);
    }
    if (response?.status() === 429) {
        throw new BotError('RATE_LIMITED', 'Instagram answered 429 (too many requests). Stopping; try again in a few hours.');
    }

    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const current = page.url();
        assertNotBounced(current);
        const meta = await page
            .evaluate(() =>
                Object.fromEntries(
                    [...document.querySelectorAll('meta[property], meta[name]')].map(m => [
                        m.getAttribute('property') ?? m.getAttribute('name') ?? '',
                        m.getAttribute('content') ?? '',
                    ])
                )
            )
            .catch(() => null); // mid-navigation
        if (meta?.['og:url']) return { status: 'ok', ...parseMeta(meta) };
        if (await isVisible(page.getByText(PRIVATE_TEXT))) return { status: 'private' };
        if (await isVisible(page.getByText(UNAVAILABLE_TEXT))) return { status: 'unavailable' };
        if (Date.now() >= deadline) {
            throw new BotError('UNKNOWN_PAGE', `Nothing recognisable at ${current}; Instagram's page may have changed.`);
        }
        await sleep(250);
    }
}

/** For diagnosing a changed page: where the browser is, its text boxes' labels and its dialogs' titles (no message text). */
export async function describePage(page: Page): Promise<string> {
    const seen = await page
        .evaluate(() => ({
            boxes: [...document.querySelectorAll('[role="textbox"], [contenteditable="true"], textarea')].map(
                el => ['role', 'aria-label', 'aria-placeholder', 'placeholder'].filter(name => el.hasAttribute(name)).map(name => `${name}=${el.getAttribute(name)}`).join(' ') || el.tagName.toLowerCase()
            ),
            dialogs: [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')]
                .map(dialog => dialog.querySelector('h1, h2, h3, [role="heading"]')?.textContent?.trim() ?? '')
                .filter(Boolean),
        }))
        .catch(() => ({ boxes: [], dialogs: [] }));
    return `Page: ${page.url()} | text boxes: ${JSON.stringify(seen.boxes)} | dialogs: ${JSON.stringify(seen.dialogs)}`;
}
