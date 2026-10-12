import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readThread, threadUrl } from '../src/thread';
import { BotError, ErrorCategory } from '../src/logger';
import { htmlPage, offlinePage, serveHtml, useBrowser } from './helpers';

useBrowser();

const CHAT = 'https://www.instagram.com/direct/t/340282366841710300949128137443944319108/';
const fast = { timeoutMs: 3000, loadWaitMs: 600 };

// Chat rows. A shared reel is a card linking to the reel; a pasted link is plain text.
const shared = (href: string) => `<div role="row"><a href="${href}" role="link"><img alt="" width="60" height="60"><span>creator</span></a></div>`;
const said = (html: string) => `<div role="row"><div dir="auto">${html}</div></div>`;

// Oldest batch first. The newest batch shares OLD111 again; /someone/ is a profile link, not a reel.
const HISTORY = [
    [shared('/reel/OLD111/'), said('old one: instagram.com/p/OLD222/'), said('haha')],
    [shared('/p/MID111/'), said('<a href="/someone/">someone</a> check this'), said('ok')],
    [shared('/reel/NEW111/'), said('https://www.instagram.com/reel/NEW222/?igsh=abc123'), shared('/reel/OLD111/')],
];

/**
 * A chat page shaped like Instagram's: the message list scrolls in reverse (newest at the bottom), sits
 * right above the message box (labelled only by aria-placeholder="Message...", as on the live page on 2026-10-12), loads older messages only when scrolled to the top, and keeps just a
 * window of them rendered - so links have to be collected while scrolling.
 */
const chatPage = (batches: string[][], { notificationsPrompt = false } = {}) => `
<style>[role=row] { height: 120px; }</style>
<div role="main">
  <div id="messages" style="height: 300px; overflow-y: auto; display: flex; flex-direction: column-reverse;"><div id="list"></div></div>
  <div contenteditable="true" aria-placeholder="Message..." style="height: 40px;"></div>
</div>
${notificationsPrompt ? `<div role="dialog" id="notifications" style="position: fixed; inset: 0; background: #fff;">
  <h2>Turn on Notifications</h2><button onclick="this.parentElement.remove()">Not Now</button><button>Turn On</button></div>` : ''}
<script>
  const batches = ${JSON.stringify(batches)};
  const list = document.getElementById('list'), messages = document.getElementById('messages');
  const render = i => Object.assign(document.createElement('div'), { innerHTML: batches[i].join('') });
  let oldest = batches.length - 1, loading = false;
  list.append(render(oldest));
  messages.addEventListener('scroll', () => {
    const atTop = messages.scrollTop <= -(messages.scrollHeight - messages.clientHeight) + 2;
    if (!atTop || loading || oldest === 0) return;
    loading = true;
    setTimeout(() => {
      list.prepend(render(--oldest));
      if (list.children.length > 2) list.lastElementChild.remove();
      loading = false;
    }, 150);
  });
</script>`;

async function chatServing(body: string) {
    return offlinePage((route, url) =>
        serveHtml(route, htmlPage(url.pathname.startsWith('/direct/t/') ? body : '<h2>Login</h2>'))
    );
}

async function rejectsWith(promise: Promise<unknown>, category: ErrorCategory): Promise<void> {
    await assert.rejects(promise, (e: unknown) => e instanceof BotError && e.category === category);
}

const codes = (items: { shortcode: string }[]) => items.map(item => item.shortcode).sort();

describe('threadUrl', () => {
    test('accepts a chat address, with or without extras', () => {
        assert.equal(threadUrl(CHAT), CHAT);
        assert.equal(threadUrl('https://instagram.com/direct/t/340282366841710300949128137443944319108?hl=en'), CHAT);
    });

    test('rejects invite links, the inbox, reel links and junk', () => {
        for (const raw of ['https://ig.me/j/AbCdEfGh/', 'https://www.instagram.com/direct/inbox/', 'https://www.instagram.com/reel/AAA111/', 'not a link']) {
            assert.equal(threadUrl(raw), null, raw);
        }
    });
});

describe('readThread', () => {
    test('collects every shared reel and pasted link while scrolling up through the history', async () => {
        const items = await readThread(await chatServing(chatPage(HISTORY)), CHAT, fast);
        assert.deepEqual(codes(items), ['MID111', 'NEW111', 'NEW222', 'OLD111', 'OLD222']);
        assert.ok(items.every(item => item.conversation === CHAT));
        assert.equal(items.find(item => item.shortcode === 'NEW222')?.url, 'https://www.instagram.com/reel/NEW222/');
    });

    test('dismisses the "Turn on Notifications" prompt before reading', async () => {
        const page = await chatServing(chatPage(HISTORY, { notificationsPrompt: true }));
        const items = await readThread(page, CHAT, fast);
        assert.equal(await page.locator('#notifications').count(), 0);
        assert.equal(items.length, 5);
    });

    test('reads a short chat that does not scroll', async () => {
        const items = await readThread(await chatServing(chatPage([[shared('/reel/ONLY11/')]])), CHAT, fast);
        assert.deepEqual(codes(items), ['ONLY11']);
    });

    test('raises SESSION_EXPIRED when the chat bounces to the login page', async () => {
        const page = await chatServing(`<script>location.replace('/accounts/login/?next=%2Fdirect%2Ft%2F1%2F')</script>`);
        await rejectsWith(readThread(page, CHAT, fast), 'SESSION_EXPIRED');
    });

    test('raises UNKNOWN_PAGE when the chat never opens', async () => {
        const page = await chatServing('<h2>Something went wrong</h2>');
        await rejectsWith(readThread(page, CHAT, { ...fast, timeoutMs: 800 }), 'UNKNOWN_PAGE');
    });
});
