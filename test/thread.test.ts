import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { dayOf, readThread, threadUrl } from '../src/thread';
import { BotError, ErrorCategory } from '../src/logger';
import { htmlPage, offlinePage, serveHtml, useBrowser } from './helpers';

useBrowser();

const CHAT = 'https://www.instagram.com/direct/t/340282366841710300949128137443944319108/';
const fast = { timeoutMs: 3000, loadWaitMs: 1500 }; // generous: the machine may be busy

// Chat rows. A shared reel is a card linking to the reel; a pasted link is plain text.
const shared = (href: string) => `<div role="row"><a href="${href}" role="link"><img alt="" width="60" height="60"><span>creator</span></a></div>`;
const said = (html: string) => `<div role="row"><div dir="auto">${html}</div></div>`;

const chatter = [said('haha'), said('ok')];
// A day marker between message groups; Instagram may split it over several elements.
const marker = (...parts: string[]) => `<div role="row"><div style="text-align: center">${parts.map(part => `<span>${part}</span>`).join(' ')}</div></div>`;
const todayOnly = { ...fast, todayOnly: true };

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

describe('dayOf', () => {
    test("tells today's markers from earlier days' and from ordinary messages", () => {
        for (const text of ['9:41 PM', '12:05 am', 'Today 9:41 PM', 'Today at 21:41', '9:41\u202fPM']) assert.equal(dayOf(text), 'today', text);
        for (const text of ['Yesterday 11:02 PM', 'Yesterday at 23:02', 'Mon 9:41 PM', 'Oct 7, 9:41 PM', 'Oct 7, 2025, 9:41 PM', '7 Oct 2025, 21:41', '10/07/25, 9:41 PM']) {
            assert.equal(dayOf(text), 'earlier', text);
        }
        for (const text of ['meet at 9:30', 'ok', 'yesterday', 'Sat']) assert.equal(dayOf(text), undefined, text);
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

    test('stops scrolling once it reaches reels already queued from this chat', async () => {
        const history = [
            [shared('/reel/OLDEST1/'), ...chatter], // beyond the part read last time: not reached
            [shared('/reel/KNOWN1/'), said('instagram.com/p/KNOWN2/'), said('ok')],
            [shared('/reel/KNOWN3/'), ...chatter],
            [shared('/reel/NEW111/'), said('https://www.instagram.com/reel/NEW222/'), said('ok')],
        ];
        const items = await readThread(await chatServing(chatPage(history)), CHAT, { ...fast, known: new Set(['KNOWN1', 'KNOWN2', 'KNOWN3']) });
        assert.deepEqual(codes(items), ['KNOWN1', 'KNOWN2', 'KNOWN3', 'NEW111', 'NEW222']);
    });

    test('keeps scrolling past a single old reel shared again', async () => {
        const history = [
            [shared('/reel/OLDEST1/'), ...chatter],
            [shared('/reel/KNOWN1/'), shared('/reel/KNOWN2/'), shared('/reel/KNOWN3/'), shared('/reel/KNOWN4/')],
            [shared('/reel/NEW111/'), ...chatter],
            [shared('/reel/KNOWN1/'), ...chatter], // an old reel shared again, newer than NEW111
            [shared('/reel/NEW222/'), ...chatter],
        ];
        const known = new Set(['KNOWN1', 'KNOWN2', 'KNOWN3', 'KNOWN4']);
        const items = await readThread(await chatServing(chatPage(history)), CHAT, { ...fast, known });
        assert.deepEqual(codes(items), ['KNOWN1', 'KNOWN2', 'KNOWN3', 'KNOWN4', 'NEW111', 'NEW222']);
    });

    test("todayOnly: returns only today's reels, reading back to the first earlier day marker", async () => {
        const history = [
            [shared('/reel/OLDEST1/'), ...chatter],
            [marker('Yesterday', '11:40 PM'), shared('/reel/YDAY111/'), said('ok')],
            [marker('10:02 AM'), shared('/reel/TODAY11/'), said('https://www.instagram.com/reel/TODAY22/'), said('ok')],
            [marker('2:30 PM'), shared('/reel/TODAY33/'), ...chatter],
        ];
        const items = await readThread(await chatServing(chatPage(history)), CHAT, todayOnly);
        assert.deepEqual(codes(items), ['TODAY11', 'TODAY22', 'TODAY33']);
    });

    test("todayOnly: dates reels whose marker comes into view only after they scrolled out of it", async () => {
        const history = [
            [marker('Yesterday', '8:00 PM'), shared('/reel/YDAY111/'), ...chatter],
            [marker('9:00 AM'), shared('/reel/TODAY11/'), ...chatter],
            [shared('/reel/TODAY22/'), ...chatter], // no marker of their own: still the 9:00 AM group
            [shared('/reel/TODAY33/'), ...chatter],
        ];
        const items = await readThread(await chatServing(chatPage(history)), CHAT, todayOnly);
        assert.deepEqual(codes(items), ['TODAY11', 'TODAY22', 'TODAY33']);
    });

    test("todayOnly: opens today's shared reel cards (no link in the page) to get their address, skipping photos", async () => {
        const card = (code: string) => `<div role="row" style="height: 360px"><div role="button" onclick="location.href='/p/${code}/'"><img src="/media/${code}.jpg" width="200" height="355" alt=""><svg aria-label="Clip" width="16" height="16"></svg></div></div>`;
        const photo = `<div role="row" style="height: 360px"><div role="button"><img src="/media/photo.jpg" width="200" height="355" alt=""></div></div>`;
        const history = [
            [marker('Yesterday', '9:00 PM'), card('YCARD11'), said('ok')],
            [marker('10:00 AM'), card('CARD111'), photo, said('nice'), card('CARD222')],
        ];
        const items = await readThread(await chatServing(chatPage(history)), CHAT, todayOnly);
        assert.deepEqual(codes(items), ['CARD111', 'CARD222']);
        assert.equal(items.find(item => item.shortcode === 'CARD111')?.url, 'https://www.instagram.com/p/CARD111/');
    });

    test('todayOnly: reads a short chat that does not scroll', async () => {
        const items = await readThread(await chatServing(chatPage([[marker('9:00 AM'), shared('/reel/ONLY11/')]])), CHAT, todayOnly);
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
