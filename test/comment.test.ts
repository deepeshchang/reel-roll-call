import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Page } from 'playwright';
import { pickPhrase, postAndRecord, postComment } from '../src/comment';
import { ReelStore } from '../src/db';
import { BotError, ErrorCategory } from '../src/logger';
import { htmlPage, offlinePage, Respond, serveHtml, useBrowser } from './helpers';

useBrowser();

const REEL = 'https://www.instagram.com/reel/AAA111/';
const COMMENT_ENDPOINT = '/api/v1/web/comments/123/add/';
const COMMENT = 'Nice content 😊';

type Reply = 'ok' | 'blocked' | 'refused' | 'late-refusal' | 'silent' | 'cleared';

// A logged-in reel page's comment form: a textarea "Add a comment…" and a div "Post" button that stays
// aria-disabled until there is text. Post sends one request; the reply decides what the page shows next.
// The list already holds someone else's identical comment, so "the text is on the page" proves nothing.
const REEL_WITH_COMMENT_FORM = `
<main><article>
  <ul id="comments"><li><a href="/someone_else/">someone_else</a> <span>${COMMENT}</span></li></ul>
  <form method="POST">
    <textarea aria-label="Add a comment…" placeholder="Add a comment…" autocomplete="off"></textarea>
    <div role="button" tabindex="0" aria-disabled="true">Post</div>
  </form>
</article></main>
<script>
  const box = document.querySelector('textarea'), post = document.querySelector('form [role=button]');
  const show = html => document.body.insertAdjacentHTML('beforeend', html);
  box.addEventListener('input', () => box.value.trim() ? post.removeAttribute('aria-disabled') : post.setAttribute('aria-disabled', 'true'));
  post.addEventListener('click', async () => {
    if (post.getAttribute('aria-disabled') === 'true') return;
    const { reply } = await (await fetch('${COMMENT_ENDPOINT}', { method: 'POST', body: new URLSearchParams({ comment_text: box.value }) })).json();
    if (reply === 'silent') return;
    if (reply === 'blocked') return show('<div role="dialog"><h3>Try Again Later</h3><p>We restrict certain activity to protect our community.</p></div>');
    if (reply === 'refused') return show("<p>Couldn't post comment.</p>");
    if (reply === 'cleared') return void (box.value = '');
    const li = document.createElement('li');
    li.innerHTML = '<a href="/test_account/">test_account</a> <span></span>';
    li.querySelector('span').textContent = box.value;
    document.getElementById('comments').append(li);
    box.value = '';
    if (reply === 'late-refusal') setTimeout(() => show("<p>Couldn't post comment.</p>"), 500);
  });
</script>`;

/** Serves the reel page and records every comment POSTed to it. */
function fakeReel(reply: Reply, body = REEL_WITH_COMMENT_FORM) {
    const posted: string[] = [];
    const respond: Respond = async (route, url) => {
        if (url.pathname === COMMENT_ENDPOINT) {
            posted.push(new URLSearchParams(route.request().postData() ?? '').get('comment_text') ?? '');
            return route.fulfill({ json: { reply } });
        }
        return serveHtml(route, htmlPage(body));
    };
    return { respond, posted };
}

async function openFakeReel(reply: Reply, body?: string) {
    const site = fakeReel(reply, body);
    const page = await offlinePage(site.respond);
    await page.goto(REEL);
    return { page, posted: site.posted };
}

async function rejectsWith(promise: Promise<unknown>, category: ErrorCategory): Promise<void> {
    await assert.rejects(promise, (e: unknown) => e instanceof BotError && e.category === category);
}

describe('postComment', () => {
    test('types the comment, clicks Post once, and confirms it appeared', async () => {
        const { page, posted } = await openFakeReel('ok');
        assert.equal(await postComment(page, COMMENT), 'posted');
        assert.deepEqual(posted, [COMMENT]);
    });

    test('dry run types the comment and clears it again without clicking Post', async () => {
        const { page, posted } = await openFakeReel('ok');
        assert.equal(await postComment(page, COMMENT, { dryRun: true }), 'dry_run');
        assert.deepEqual(posted, []);
        assert.equal(await page.locator('textarea').inputValue(), '');
    });

    test('stops on "Try Again Later" without retrying', async () => {
        const { page, posted } = await openFakeReel('blocked');
        await rejectsWith(postComment(page, COMMENT), 'RATE_LIMITED');
        assert.equal(posted.length, 1);
    });

    test("reports Instagram's refusal as COMMENT_FAILED", async () => {
        const { page, posted } = await openFakeReel('refused');
        await rejectsWith(postComment(page, COMMENT), 'COMMENT_FAILED');
        assert.equal(posted.length, 1);
    });

    test('catches a refusal that shows up just after the comment appeared', async () => {
        const { page } = await openFakeReel('late-refusal');
        await rejectsWith(postComment(page, COMMENT), 'COMMENT_FAILED');
    });

    test('says "unconfirmed" when nothing changes after Post (an older identical comment does not count)', async () => {
        const { page, posted } = await openFakeReel('silent');
        assert.equal(await postComment(page, COMMENT, { timeoutMs: 3000 }), 'unconfirmed');
        assert.equal(posted.length, 1);
    });

    test("is not fooled by someone else's identical comment when ours never shows up", async () => {
        const { page } = await openFakeReel('cleared');
        assert.equal(await postComment(page, COMMENT, { timeoutMs: 3000 }), 'unconfirmed');
    });

    test('skips a reel with comments turned off, typing nothing', async () => {
        const { page, posted } = await openFakeReel('ok', '<main><article><p>Commenting has been turned off.</p></article></main>');
        assert.equal(await postComment(page, COMMENT), 'comments_off');
        assert.deepEqual(posted, []);
    });

    test('raises UNKNOWN_PAGE when there is no comment box', async () => {
        const { page } = await openFakeReel('ok', '<main><article>reel</article></main>');
        await rejectsWith(postComment(page, COMMENT, { timeoutMs: 800 }), 'UNKNOWN_PAGE');
    });
});

describe('postAndRecord', () => {
    function store() {
        const db = new ReelStore(':memory:');
        db.add({ shortcode: 'AAA111', url: REEL }, 'dm-thread');
        return { save: (fields: Parameters<ReelStore['update']>[1]) => db.update('AAA111', fields), row: () => db.recent(1)[0] };
    }

    test('records a posted comment as submitted', async () => {
        const { save, row } = store();
        const { page } = await openFakeReel('ok');
        assert.equal(await postAndRecord(page, COMMENT, save), 'posted');
        assert.equal(row().status, 'submitted');
        assert.equal(row().final_comment, COMMENT);
        assert.equal(row().submission, 'posted automatically');
        assert.ok(row().submitted_at);
    });

    test('keeps a blocked comment approved and ready, so the next run posts it', async () => {
        const { save, row } = store();
        const { page } = await openFakeReel('blocked');
        await rejectsWith(postAndRecord(page, COMMENT, save), 'RATE_LIMITED');
        assert.equal(row().status, 'approved');
        assert.equal(row().submission, null);
        assert.equal(row().final_comment, COMMENT);
    });

    test('marks a refused comment as failed', async () => {
        const { save, row } = store();
        const { page } = await openFakeReel('refused');
        await rejectsWith(postAndRecord(page, COMMENT, save), 'COMMENT_FAILED');
        assert.equal(row().status, 'failed');
        assert.match(row().error ?? '', /^COMMENT_FAILED: /);
    });

    test('records an unconfirmed comment as submitted, so it is never posted twice', async () => {
        const { save, row } = store();
        const { page } = await openFakeReel('silent');
        assert.equal(await postAndRecord(page, COMMENT, save, { timeoutMs: 2000 }), 'unconfirmed');
        assert.equal(row().status, 'submitted');
        assert.match(row().submission ?? '', /^unconfirmed/);
    });

    test('a crash while posting leaves the reel marked "posting", which is never retried', async () => {
        const { save, row } = store();
        const site = fakeReel('silent');
        let page: Page | undefined;
        page = await offlinePage(async (route, url) => {
            await site.respond(route, url);
            if (url.pathname === COMMENT_ENDPOINT) setTimeout(() => void page?.close(), 100);
        });
        await page.goto(REEL);
        await assert.rejects(postAndRecord(page, COMMENT, save));
        assert.equal(row().status, 'approved');
        assert.equal(row().submission, 'posting');
    });
});

describe('pickPhrase', () => {
    test('never uses the same phrase twice in a row', () => {
        const phrases = ['Nice content 😊', 'Nice content 🙌', 'Cool content <3'];
        let last: string | undefined;
        for (let i = 0; i < 100; i++) {
            const next = pickPhrase(phrases, last);
            assert.ok(phrases.includes(next), next);
            assert.notEqual(next, last);
            last = next;
        }
    });

    test('repeats the only phrase there is', () => {
        assert.equal(pickPhrase(['Cool content <3'], 'Cool content <3'), 'Cool content <3');
    });
});
