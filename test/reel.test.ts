import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openReel } from '../src/reel';
import { BotError, ErrorCategory } from '../src/logger';
import { CHALLENGE_PAGE, htmlPage, offlinePage, serveHtml, useBrowser } from './helpers';

useBrowser();

const REEL = 'https://www.instagram.com/reel/DePb6WLuVae/';

// <head> of the live public page /instagram/reel/DePb6WLuVae/ as captured on 2026-10-12 (image URLs shortened).
const LIVE_REEL_HEAD = `
<meta property="og:type" content="article">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@instagram">
<meta name="twitter:maxage" content="86400">
<meta name="twitter:image" content="https://scontent.cdninstagram.com/v/t51.82787-15/840589610_n.jpg?stp=dst-jpg">
<meta name="twitter:title" content="Instagram (@instagram) • Instagram reel">
<meta property="instapp:owner_user_id" content="25025320">
<meta name="description" content="638K likes, 16K comments - instagram on October 8, 2026: &quot;fur real, every single one of these is the best one 🐾&#10;&#10;#InTheMoment&#10;&#10;Video by @miso_ara&quot;. ">
<meta property="og:site_name" content="Instagram">
<meta property="og:title" content="Instagram on Instagram: &quot;fur real, every single one of these is the best one 🐾&#10;&#10;#InTheMoment&#10;&#10;Video by @miso_ara&quot;">
<meta property="og:image" content="https://scontent.cdninstagram.com/v/t51.82787-15/840589610_n.jpg?stp=dst-jpg">
<meta property="og:url" content="https://www.instagram.com/instagram/reel/DePb6WLuVae/">
<meta property="og:description" content="638K likes, 16K comments - instagram on October 8, 2026: &quot;fur real, every single one of these is the best one 🐾&#10;&#10;#InTheMoment&#10;&#10;Video by @miso_ara&quot;. ">
<link rel="canonical" href="https://www.instagram.com/instagram/reel/DePb6WLuVae/">`;

const pageServing = (body: string, head = '', status = 200) => offlinePage(route => serveHtml(route, htmlPage(body, head), status));

async function rejectsWith(promise: Promise<unknown>, category: ErrorCategory): Promise<void> {
    await assert.rejects(promise, (e: unknown) => e instanceof BotError && e.category === category);
}

describe('openReel', () => {
    test("reads the real author and caption from the page's meta tags", async () => {
        const info = await openReel(await pageServing('<main>reel</main>', LIVE_REEL_HEAD), REEL);
        assert.deepEqual(info, {
            status: 'ok',
            author: 'instagram',
            caption: 'fur real, every single one of these is the best one 🐾\n\n#InTheMoment\n\nVideo by @miso_ara',
            imageUrl: 'https://scontent.cdninstagram.com/v/t51.82787-15/840589610_n.jpg?stp=dst-jpg',
        });
    });

    test('opens reels in the post layout (/p/), which has the comment box - /reel/ opens the full-screen player without one', async () => {
        const page = await offlinePage((route, url) =>
            serveHtml(route, htmlPage(url.pathname.startsWith('/p/') ? '<main>post layout</main>' : '<main>reels player</main>', LIVE_REEL_HEAD))
        );
        await openReel(page, REEL);
        assert.equal(new URL(page.url()).pathname, '/p/DePb6WLuVae/');
    });

    test('reports a deleted or broken link as unavailable (live wording)', async () => {
        const page = await pageServing('<main><span>Post isn\'t available</span><span>The link may be broken, or the profile may have been removed.</span></main>');
        assert.deepEqual(await openReel(page, REEL), { status: 'unavailable' });
    });

    test("reports a private account's post as private", async () => {
        const page = await pageServing('<main><h2>This account is private</h2><p>Follow to see their photos and videos.</p></main>');
        assert.deepEqual(await openReel(page, REEL), { status: 'private' });
    });

    test('raises SESSION_EXPIRED when Instagram bounces to the login page', async () => {
        const page = await offlinePage((route, url) =>
            serveHtml(route, htmlPage(url.pathname.startsWith('/accounts/login') ? 'login' : `<script>location.replace('/accounts/login/?next=%2Freel%2FDePb6WLuVae%2F')</script>`))
        );
        await rejectsWith(openReel(page, REEL), 'SESSION_EXPIRED');
    });

    test('raises CHECKPOINT when Instagram redirects to a challenge', async () => {
        const page = await offlinePage((route, url) =>
            serveHtml(route, htmlPage(url.pathname.startsWith('/challenge') ? CHALLENGE_PAGE : `<script>location.replace('/challenge/AbC/')</script>`))
        );
        await rejectsWith(openReel(page, REEL), 'CHECKPOINT');
    });

    test('raises RATE_LIMITED on HTTP 429', async () => {
        await rejectsWith(openReel(await pageServing('Too many requests', '', 429), REEL), 'RATE_LIMITED');
    });

    test('raises UNKNOWN_PAGE when nothing recognisable appears before the timeout', async () => {
        await rejectsWith(openReel(await pageServing('<p>Loading…</p>'), REEL, 800), 'UNKNOWN_PAGE');
    });

    test('raises NETWORK when the page cannot load', async () => {
        await rejectsWith(openReel(await offlinePage(route => route.abort('internetdisconnected')), REEL), 'NETWORK');
    });
});
