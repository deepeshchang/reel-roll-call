import { Page } from 'playwright';
import { setTimeout as sleep } from 'timers/promises';
import { firstLine, isVisible, RATE_LIMIT_TEXT } from './auth';
import { ReelStore } from './db';
import { BotError } from './logger';
import { describePage } from './reel';

export type CommentOutcome = 'posted' | 'unconfirmed' | 'comments_off' | 'dry_run';
export type LikeOutcome = 'liked' | 'already_liked' | 'unconfirmed' | 'dry_run';
export type Save = (fields: Parameters<ReelStore['update']>[1]) => void;

const COMMENTS_OFF_TEXT = /commenting (has been|is) (turned off|limited)|comments on this post (have been|are) (limited|turned off)/i;
const REFUSED_TEXT = /could(n.t| not) post( your)? comment|unable to post comment/i;
const SETTLE_MS = 2000; // a refusal can replace the optimistically shown comment a moment later

/**
 * Whether a comment by `username` is among the comments shown on the post open in `page`. Only the post
 * counts (the menu links to your profile too). ponytail: Instagram shows only part of long comment threads.
 */
export async function alreadyCommented(page: Page, username: string): Promise<boolean> {
    const name = username.toLowerCase();
    return page
        .locator('main a[href]')
        .evaluateAll(
            (links, name) => links.some(a => new URL((a as HTMLAnchorElement).href).pathname.toLowerCase().replace(/\/$/, '') === `/${name}` && a.textContent?.trim().toLowerCase() === name),
            name
        );
}

/**
 * Likes the post open in `page` with one click on its heart - never when it is already liked, since a
 * click would unlike it. Throws RATE_LIMITED (Instagram blocked it) or UNKNOWN_PAGE (no Like button).
 */
export async function likePost(page: Page, opts: { dryRun?: boolean; timeoutMs?: number } = {}): Promise<LikeOutcome> {
    const timeout = opts.timeoutMs ?? 20000;
    // The post's own heart is the biggest: each comment has a small one with the same label.
    const hearts = page.locator('svg:is([aria-label="Like"], [aria-label="Unlike"])').filter({ visible: true });
    const postHeart = async () => {
        const widths = await hearts.evaluateAll(svgs => svgs.map(svg => svg.getBoundingClientRect().width));
        return widths.length ? hearts.nth(widths.indexOf(Math.max(...widths))) : undefined;
    };
    const ready = Date.now() + timeout;
    let heart = await postHeart();
    while (!heart) {
        if (Date.now() >= ready) {
            throw new BotError('UNKNOWN_PAGE', `No Like button on the reel page; Instagram's page may have changed. Nothing was liked. ${await describePage(page)}`);
        }
        await sleep(250);
        heart = await postHeart();
    }
    if ((await heart.getAttribute('aria-label')) === 'Unlike') return 'already_liked';
    if (opts.dryRun) return 'dry_run';

    const blocked = page.getByText(RATE_LIMIT_TEXT);
    const before = await blocked.count();
    try {
        await heart.click({ timeout });
    } catch (e) {
        throw new BotError('UNKNOWN_PAGE', `Could not click Like (${firstLine(e)}). Nothing was liked.`);
    }
    const confirmBy = Date.now() + Math.min(timeout, 10000);
    for (;;) {
        if ((await blocked.count()) > before) {
            throw new BotError('RATE_LIMITED', 'Instagram blocked the like ("Try again later"). Stopping; wait a few hours, then lower DAILY_LIMIT or raise COMMENT_GAP_SECONDS.');
        }
        if ((await (await postHeart())?.getAttribute('aria-label')) === 'Unlike') return 'liked';
        if (Date.now() >= confirmBy) return 'unconfirmed'; // not clicked again: a second click could unlike it
        await sleep(250);
    }
}

/**
 * Comments on the reel open in `page`: types into "Add a comment…" and clicks Post once - never again.
 * Throws RATE_LIMITED (Instagram blocked it), COMMENT_FAILED (Instagram refused it) or UNKNOWN_PAGE
 * (no usable comment box, nothing posted). Dry run types the comment and clears it without posting.
 */
export async function postComment(page: Page, comment: string, opts: { dryRun?: boolean; timeoutMs?: number } = {}): Promise<CommentOutcome> {
    const timeout = opts.timeoutMs ?? 20000;
    // Matched on the label attributes: if the label is only an aria-placeholder, the box has no accessible name.
    const box = page
        .locator(':is([role="textbox"], [contenteditable="true"], textarea):is([aria-label^="add a comment" i], [aria-placeholder^="add a comment" i], [placeholder^="add a comment" i])')
        .filter({ visible: true })
        .first();
    const ready = Date.now() + timeout;
    while (!(await isVisible(box))) {
        if (await isVisible(page.getByText(COMMENTS_OFF_TEXT))) return 'comments_off';
        if (Date.now() >= ready) {
            throw new BotError('UNKNOWN_PAGE', `No comment box on the reel page; Instagram's page may have changed. Nothing was posted. ${await describePage(page)}`);
        }
        await sleep(250);
    }

    // Counted first: older comments may already say the same words, or "try again later".
    const shown = page.getByText(comment);
    const blocked = page.getByText(RATE_LIMIT_TEXT);
    const refused = page.getByText(REFUSED_TEXT);
    const before = { shown: await shown.count(), blocked: await blocked.count(), refused: await refused.count() };

    const post = page.getByRole('button', { name: /^post$/i }).filter({ visible: true }).first();
    try {
        await box.fill(comment, { timeout });
        if (opts.dryRun) {
            await post.waitFor({ timeout });
            await box.fill('', { timeout });
            return 'dry_run';
        }
        await post.click({ timeout }); // waits until Post is enabled
    } catch (e) {
        throw new BotError('UNKNOWN_PAGE', `Could not use the comment box (${firstLine(e)}). Nothing was posted.`);
    }

    const confirmBy = Date.now() + timeout;
    let seenAt = 0;
    for (;;) {
        if ((await blocked.count()) > before.blocked) {
            throw new BotError('RATE_LIMITED', 'Instagram blocked the comment ("Try again later"). Stopping; wait a few hours, then lower DAILY_LIMIT or raise COMMENT_GAP_SECONDS.');
        }
        if ((await refused.count()) > before.refused) {
            throw new BotError('COMMENT_FAILED', 'Instagram refused the comment ("Couldn\'t post comment"). Stopping.');
        }
        // Posted = the box emptied and one more copy of the comment is on the page, with no refusal after it.
        const cleared = (await box.inputValue({ timeout: 1000 }).catch(() => '')) === '';
        if (cleared && (await shown.count()) > before.shown) {
            seenAt ||= Date.now();
            if (Date.now() - seenAt >= SETTLE_MS) return 'posted';
        } else {
            seenAt = 0;
            if (Date.now() >= confirmBy) return 'unconfirmed';
        }
        await sleep(250);
    }
}

/**
 * postComment, keeping the database in step so no reel is ever commented on twice: the reel is marked
 * "posting" before Post is clicked, and only a definite "not posted" makes it eligible again.
 */
export async function postAndRecord(page: Page, comment: string, save: Save, opts: { timeoutMs?: number } = {}): Promise<CommentOutcome> {
    save({ status: 'approved', final_comment: comment, submission: 'posting', error: null });
    let outcome: CommentOutcome;
    try {
        outcome = await postComment(page, comment, opts);
    } catch (e) {
        if (!(e instanceof BotError)) {
            save({ error: `Interrupted while posting - check the reel: ${firstLine(e)}` }); // stays "posting": never retried
        } else if (e.category === 'RATE_LIMITED') {
            save({ submission: null, error: `${e.category}: ${e.message}` }); // blocked, so not posted: the next run retries
        } else {
            save({ status: 'failed', submission: null, error: `${e.category}: ${e.message}` });
        }
        throw e;
    }
    const now = new Date().toISOString();
    if (outcome === 'posted') {
        save({ status: 'submitted', submitted_at: now, submission: 'posted automatically' });
    } else if (outcome === 'unconfirmed') {
        save({ status: 'submitted', submitted_at: now, submission: 'unconfirmed: clicked Post, but the comment did not show up - check the reel' });
    } else {
        save({ status: 'skipped', submission: null, error: 'Comments are turned off for this reel.' });
    }
    return outcome;
}
