import { Page } from 'playwright';
import { setTimeout as sleep } from 'timers/promises';
import { firstLine, isVisible } from './auth';
import { extractRefs, Shared } from './ingest';
import { BotError, Logger } from './logger';
import { assertNotBounced, describePage } from './reel';

const THREAD_PATH = /^\/direct\/t\/([A-Za-z0-9_-]+)\/?$/;
// Reading stops after this many already-queued links in a row (newest first): the part read last time.
// One old reel shared again is not enough to stop it.
const KNOWN_IN_A_ROW = 3;

// Instagram's markers between message groups (pages are in English). Today's show only the time
// ("9:41 PM", or "Today 9:41 PM"); earlier days' add the day ("Yesterday 9:41 PM", "Mon 9:41 PM", "Oct 7, 9:41 PM").
const TIME = String.raw`\d{1,2}[:.]\d{2}(?:\s?[ap]\.?m\.?)?`;
const MONTH = String.raw`(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?`;
const WEEKDAY = String.raw`(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?`;
const TODAY_MARKER = new RegExp(String.raw`^(?:today,?\s+(?:at\s+)?)?${TIME}$`, 'i');
const EARLIER_MARKER = new RegExp(
    String.raw`^(?:yesterday|${WEEKDAY}|${MONTH}\s+\d{1,2}|\d{1,2}\s+${MONTH}|\d{1,2}/\d{1,2}/\d{2,4}),?\s+(?:\d{4},?\s+)?(?:at\s+)?${TIME}$`,
    'i'
);

/** Whether a day marker's text is from today or an earlier day; undefined for anything else. */
export function dayOf(marker: string): 'today' | 'earlier' | undefined {
    const text = marker.replace(/\s+/g, ' ').trim();
    return TODAY_MARKER.test(text) ? 'today' : EARLIER_MARKER.test(text) ? 'earlier' : undefined;
}

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
    /** Only reels shared today: reading stops at the first marker of an earlier day ("Yesterday 9:41 PM"). */
    todayOnly?: boolean;
    /** Shortcodes already queued from this chat; reading stops where they start (the part read last time). */
    known?: ReadonlySet<string>;
    signal?: AbortSignal;
    logger?: Logger;
}

/**
 * Every reel/post link in a DM conversation - shared reels and pasted links - found by scrolling up
 * through the history, back to the start, to the `known` reels, or with `todayOnly` to the previous
 * day (Ctrl+C returns what was found so far). Read-only: it types nothing and clicks only "Not Now" on the notifications prompt. Opening the
 * chat marks it seen, as a browser would.
 */
export async function readThread(page: Page, url: string, opts: ThreadOptions = {}): Promise<Shared[]> {
    const timeout = opts.timeoutMs ?? 30000;
    const { scrollable, dismissPrompt } = await openChat(page, url, timeout);

    const found = new Map<string, Shared>();
    let knownInARow = 0;
    // todayOnly: a link's day is that of the nearest marker above it.
    const today = new Set<string>();
    const dated = new Set<string>();
    let undated: string[] = []; // their marker is further up than what has been read so far
    let reachedEarlier = false;
    const markers: string[] = [];
    const unrecognised = new Set<string>();
    const codesIn = (token: Token) =>
        token.kind === 'link' ? extractRefs(token.text).map(ref => ref.shortcode) : token.kind === 'card' ? [`card:${token.text}`] : [];
    const date = (tokens: Token[]) => {
        const rendered = new Set(tokens.flatMap(codesIn));
        let open = undated.filter(code => !rendered.has(code)); // scrolled out of view: below everything shown
        for (const token of [...tokens].reverse()) {
            if (token.kind === 'other') {
                if (unrecognised.size < 5) unrecognised.add(token.text);
                continue;
            }
            const day = token.kind === 'marker' ? dayOf(token.text) : undefined;
            if (!day) {
                for (const code of codesIn(token)) if (!dated.has(code) && !open.includes(code)) open.push(code);
                continue;
            }
            if (!markers.includes(token.text)) markers.push(token.text);
            for (const code of open) {
                dated.add(code);
                if (day === 'today') today.add(code);
            }
            open = [];
            if (day === 'earlier') {
                reachedEarlier = true;
                break; // everything above it is older
            }
        }
        undated = open;
    };
    const gather = async () => {
        const tokens = await page.evaluate(readTokens, [TODAY_MARKER.source, EARLIER_MARKER.source]);
        let fresh = 0;
        let unknown = 0;
        for (const token of tokens) {
            if (token.kind !== 'link') continue;
            for (const ref of extractRefs(token.text)) {
                if (found.has(ref.shortcode)) continue;
                found.set(ref.shortcode, { ...ref, conversation: url });
                fresh++;
                if (!opts.known?.has(ref.shortcode)) unknown++;
            }
        }
        knownInARow = unknown ? 0 : knownInARow + fresh;
        if (opts.todayOnly) date(tokens);
    };
    const signature = () => messagesSignature(page);

    await gather();
    // Chats render only a window of messages, so links are gathered after every scroll. Two scrolls in a
    // row with nothing new means the top of the history.
    let idle = 0;
    let i = 0;
    for (; scrollable && idle < 2 && knownInARow < KNOWN_IN_A_ROW && !reachedEarlier && i < (opts.maxScrolls ?? 1000) && !opts.signal?.aborted; i++) {
        await dismissPrompt();
        const before = await signature();
        await scrollUp(page);
        idle = (await changes(signature, before, opts.loadWaitMs ?? 4000)) ? 0 : idle + 1;
        await gather();
        if (i % 10 === 9) opts.logger?.info(`Still scrolling up: ${found.size} link(s) so far.`);
    }
    const why = reachedEarlier ? ', back to the previous day' : knownInARow >= KNOWN_IN_A_ROW ? ', up to reels queued before' : '';
    const items = [...found.values()].filter(item => !opts.todayOnly || today.has(item.shortcode));
    const cards = [...today].filter(code => code.startsWith('card:')).map(code => code.slice(5));
    if (cards.length) opts.logger?.info(`Opening ${cards.length} shared reel card(s) from today to get their links...`);
    let missed: string[] = [];
    for (const pass of [cards, missed]) {
        for (const image of pass === missed ? [...missed.splice(0)] : pass) {
            if (opts.signal?.aborted) break;
            const item = await openCard(page, url, image, { ...opts, maxScrolls: i + 5 }).catch(e => { // no further up than the scan went
                if (e instanceof BotError && ['SESSION_EXPIRED', 'CHECKPOINT', 'RATE_LIMITED'].includes(e.category)) throw e;
                opts.logger?.debug(`Card ...${image.slice(-24)}: ${firstLine(e)}`);
                return undefined; // a slow page load: counts as a miss, retried once
            });
            if (!item) missed.push(image);
            else if (!items.some(other => other.shortcode === item.shortcode)) items.push(item);
        }
    }
    if (missed.length) opts.logger?.warn(`Could not open ${missed.length} of today's ${cards.length} shared reel card(s), even on a second try; they were skipped.`, 'UNKNOWN_PAGE');
    opts.logger?.info(
        `${scrollable ? `Scrolled up ${i} times${why}` : 'No scrollable message list found, read what was on screen'}; ${items.length} link(s)${opts.todayOnly ? ' shared today' : ''}.`
    );
    if (opts.todayOnly) {
        const shown = markers.length > 6 ? [...markers.slice(0, 5), '...', markers[markers.length - 1]] : markers;
        opts.logger?.info(`Day markers, newest first: ${shown.map(text => `"${text}"`).join(', ') || 'none'}.`);
        if (!markers.length) {
            const samples = [...unrecognised].map(text => `"${text}"`).join(', ');
            opts.logger?.warn(`No day markers recognised, so no reel could be dated. Instagram's chat page may have changed${samples ? `; time-like texts seen: ${samples}` : ''}.`, 'UNKNOWN_PAGE');
        }
    }
    return items;
}

type Token = { kind: 'link' | 'card' | 'marker' | 'other'; text: string; top: number };

/**
 * Runs in the page: the links and day markers in the message list, top to bottom ("other": short texts
 * with a time in them that are not markers, for diagnosis).
 */
function readTokens([todaySource, earlierSource]: string[]): Token[] {
    const root = document.querySelector('[data-bot-messages]') ?? document.querySelector('[role="main"]') ?? document.body;
    const today = new RegExp(todaySource, 'i');
    const earlier = new RegExp(earlierSource, 'i');
    const clean = (el: Node) => (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const isMarker = (el: Element) => today.test(clean(el)) || earlier.test(clean(el));
    const tokens: Token[] = [];
    const place = (el: Element, kind: Token['kind'], text: string) => {
        const box = el.getBoundingClientRect();
        if (box.width || box.height) tokens.push({ kind, text, top: box.top });
    };
    root.querySelectorAll('a[href]').forEach(a => place(a, 'link', (a as HTMLAnchorElement).href));
    // Shared reels: a big preview card (role=button) with no link; known by its image.
    const cards = new Set<Element>();
    root.querySelectorAll('[role="button"] img').forEach(img => {
        const card = img.closest('[role="button"]')!;
        const box = img.getBoundingClientRect();
        // Reels carry a "Clip" icon; photos and other attachments open no reel page.
        if (box.width > 150 && box.height > 250 && !img.closest('a') && !cards.has(card) && card.querySelector('svg[aria-label="Clip"]')) {
            cards.add(card); // one image per card (some have a blurred backdrop too)
            place(img, 'card', new URL((img as HTMLImageElement).src, location.href).pathname);
        }
    });
    const markers = new Set<Element>();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        const text = node.textContent ?? '';
        if (!parent) continue;
        if (/instagram\.com|instagr\.am/i.test(text)) {
            place(parent, 'link', text);
        } else if (text.length <= 40 && /\d[:.]\d\d/.test(text)) {
            // A marker may be split over elements ("Yesterday" + "9:41 PM"): take the outermost that is only the marker.
            // ponytail: a message that is just a time ("9:30") reads as a marker too; rare in these chats.
            let marker: Element | undefined;
            for (let el: Element | null = parent, depth = 0; el && el !== root && depth < 5; el = el.parentElement, depth++) {
                if (isMarker(el)) marker = el;
                else if (marker) break;
            }
            if (!marker) place(parent, 'other', clean(parent).slice(0, 40));
            else if (!markers.has(marker)) {
                markers.add(marker);
                place(marker, 'marker', clean(marker));
            }
        }
    }
    return tokens.sort((a, b) => a.top - b.top);
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

/** Opens the chat and marks its message list (data-bot-messages); throws if it does not open. */
async function openChat(page: Page, url: string, timeout: number) {
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
    return { scrollable, dismissPrompt };
}

const messagesSignature = (page: Page) =>
    page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('[data-bot-messages]');
        return el ? `${el.scrollTop}:${el.scrollHeight}:${el.innerText.length}` : '';
    });

// One screen at a time: jumping straight to the top skips rendering the messages in between.
const scrollUp = (page: Page) =>
    page.evaluate(() => {
        const el = document.querySelector('[data-bot-messages]');
        if (el) el.scrollTop -= el.clientHeight * 0.8; // works for reversed chat lists (scrollTop <= 0) and normal ones
    });

/**
 * A shared reel shows as a card with no link in the page: opens the chat again, scrolls up to the card
 * (known by its image) and clicks it, which goes to the reel's page.
 */
async function openCard(page: Page, url: string, image: string, opts: ThreadOptions): Promise<Shared | undefined> {
    await openChat(page, url, opts.timeoutMs ?? 30000);
    const card = page.locator(`[role="button"] img[src*=${JSON.stringify(image)}]`).filter({ visible: true }).first();
    const anyCopy = page.locator(`[role="button"] img[src*=${JSON.stringify(image)}]`).first();
    let misses = 0;
    let idle = 0;
    for (let i = 0; i <= (opts.maxScrolls ?? 1000) && !opts.signal?.aborted; i++) {
        if (await anyCopy.count()) {
            // The chat re-renders while loading, so the card can vanish under the click: retry a few times.
            const clicked = await anyCopy
                .scrollIntoViewIfNeeded({ timeout: 5000 })
                .then(() => card.click({ timeout: 5000 }))
                .then(() => true, () => false);
            if (!clicked) {
                if (++misses >= 3) {
                    opts.logger?.debug(`Card ...${image.slice(-24)} found but could not be clicked.`);
                    return undefined;
                }
                await sleep(1000);
                continue;
            }
            const deadline = Date.now() + 10000;
            while (Date.now() < deadline) {
                const [ref] = extractRefs(page.url());
                if (ref) return { ...ref, conversation: url };
                await sleep(250);
            }
            return undefined;
        }
        const before = await messagesSignature(page);
        await scrollUp(page);
        idle = (await changes(() => messagesSignature(page), before, opts.loadWaitMs ?? 4000)) ? 0 : idle + 1;
        if (idle >= 3) break; // top of the chat
    }
    const seen = await page.locator('[role="button"]:has(svg[aria-label="Clip"]) img').evaluateAll(imgs => imgs.map(img => (img as HTMLImageElement).src.split('?')[0].slice(-24)));
    opts.logger?.debug(`Card ...${image.slice(-24)} not found; reel cards on screen: ${seen.join(', ') || 'none'} (${page.url()})`);
    return undefined;
}
