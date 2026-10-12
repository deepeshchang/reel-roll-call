import { Page } from 'playwright';
import { setTimeout as sleep } from 'timers/promises';
import { firstLine, isVisible } from './auth';
import { extractRefs, Shared } from './ingest';
import { BotError, Logger } from './logger';
import { assertNotBounced, describePage } from './reel';

const THREAD_PATH = /^\/direct\/t\/([A-Za-z0-9_-]+)\/?$/;

/**
 * The canonical address of a DM conversation, https://www.instagram.com/direct/t/<id>/, or null.
 * Group invite links are deliberately not accepted: opening one can add you to the group.
 */
export function threadUrl(raw: string): string | null {
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        return null;
    }
    const match = THREAD_PATH.exec(url.pathname);
    return match && /^(www\.)?instagram\.com$/i.test(url.hostname) ? `https://www.instagram.com/direct/t/${match[1]}/` : null;
}

export interface ThreadOptions {
    timeoutMs?: number;
    /** How long to wait for older messages after each scroll to the top (default 4s). */
    loadWaitMs?: number;
    maxScrolls?: number;
    signal?: AbortSignal;
    logger?: Logger;
}

/**
 * Every reel/post link in a DM conversation - shared reels and pasted links - found by scrolling up
 * through the whole history (Ctrl+C returns what was found so far). Read-only: it types nothing and
 * clicks only "Not Now" on the notifications prompt. Opening the chat marks it seen, as a browser would.
 */
export async function readThread(page: Page, url: string, opts: ThreadOptions = {}): Promise<Shared[]> {
    const timeout = opts.timeoutMs ?? 30000;
    try {
        await page.goto(`${url}?hl=en`, { waitUntil: 'domcontentloaded', timeout });
    } catch (e) {
        throw new BotError('NETWORK', `Could not load ${url} (${firstLine(e)}).`);
    }

    // The message box. Live (2026-10-12) it is a rich-text editor labelled only by aria-placeholder="Message...",
    // which gives it no accessible name, so match the label attributes directly.
    const composer = page
        .locator(':is([role="textbox"], [contenteditable="true"], textarea):is([aria-label^="message" i], [aria-placeholder^="message" i], [placeholder^="message" i])')
        .filter({ visible: true })
        .first();
    const notNow = page.getByRole('button', { name: /^not now$/i });
    const dismissPrompt = async () => {
        if (await isVisible(notNow)) await notNow.first().click({ timeout: 5000 }).catch(() => {});
    };
    const deadline = Date.now() + timeout;
    while (!(await isVisible(composer))) {
        assertNotBounced(page.url());
        if (Date.now() >= deadline) {
            throw new BotError('UNKNOWN_PAGE', `The chat ${url} did not open (no message box). Check the link, and that you are still in that chat. ${await describePage(page)}`);
        }
        await sleep(250);
    }
    await dismissPrompt();

    // The message list is the scrollable area just above the message box.
    const scrollable = await composer.evaluate(box => {
        const { left, width, top } = box.getBoundingClientRect();
        const scrolls = (el: Element) => el.scrollHeight > el.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(el).overflowY);
        for (const dy of [40, 80, 140]) {
            for (let el = document.elementFromPoint(left + width / 2, top - dy); el; el = el.parentElement) {
                if (scrolls(el)) {
                    el.setAttribute('data-bot-messages', '');
                    return true;
                }
            }
        }
        return false;
    });

    const found = new Map<string, Shared>();
    const gather = async () => {
        const text = await page.evaluate(() => {
            const root = document.querySelector('[data-bot-messages]') ?? document.querySelector('[role="main"]') ?? document.body;
            const hrefs = [...root.querySelectorAll('a[href]')].map(a => (a as HTMLAnchorElement).href);
            return [...hrefs, (root as HTMLElement).innerText].join('\n');
        });
        for (const ref of extractRefs(text)) if (!found.has(ref.shortcode)) found.set(ref.shortcode, { ...ref, conversation: url });
    };
    const signature = () =>
        page.evaluate(() => {
            const el = document.querySelector<HTMLElement>('[data-bot-messages]');
            return el ? `${el.scrollTop}:${el.scrollHeight}:${el.innerText.length}` : '';
        });

    await gather();
    // Chats render only a window of messages, so links are gathered after every scroll. Two scrolls in a
    // row with nothing new means the top of the history.
    let idle = 0;
    let i = 0;
    for (; scrollable && idle < 2 && i < (opts.maxScrolls ?? 1000) && !opts.signal?.aborted; i++) {
        await dismissPrompt();
        const before = await signature();
        // Negative because chat lists usually scroll in reverse; a normal list just clamps to 0 (its top).
        await page.evaluate(() => {
            const el = document.querySelector('[data-bot-messages]');
            if (el) el.scrollTop = -el.scrollHeight;
        });
        idle = (await changes(signature, before, opts.loadWaitMs ?? 4000)) ? 0 : idle + 1;
        await gather();
        if (i % 10 === 9) opts.logger?.info(`Still scrolling up: ${found.size} link(s) so far.`);
    }
    opts.logger?.info(`${scrollable ? `Scrolled up ${i} times` : 'No scrollable message list found, read what was on screen'}; ${found.size} link(s).`);
    return [...found.values()];
}

/** Polls `read` until it differs from `before`, for up to `waitMs`. */
async function changes(read: () => Promise<string>, before: string, waitMs: number): Promise<boolean> {
    const deadline = Date.now() + waitMs;
    for (;;) {
        if ((await read()) !== before) return true;
        if (Date.now() >= deadline) return false;
        await sleep(250);
    }
}
