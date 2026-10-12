import * as fs from 'fs';
import * as path from 'path';
import { createInterface, Interface } from 'readline/promises';
import { setTimeout as sleep } from 'timers/promises';
import { parseArgs } from 'util';
import chalk from 'chalk';
import { Page } from 'playwright';
import { config, dataDir, logsDir } from './config';
import { BotError, ErrorCategory, Logger, registerSecret } from './logger';
import { firstLine, openSession, Session } from './auth';
import { ExportThread, InputResult, readInput } from './ingest';
import { ReelRow, ReelStore } from './db';
import { openReel, ReelInfo } from './reel';
import { readThread, threadUrl } from './thread';
import { CommentOutcome, pickPhrase, postAndRecord, postComment, Save } from './comment';
import { AICommentGenerator } from './genai';
import { askApproval, describeReel } from './approval';
import { handOffForPosting } from './submit';

const log = new Logger('SYSTEM');

const USAGE = `Usage: npm run <command>   (or: npm start -- <command>)

  login                   Open a visible browser and log in; complete any 2FA / security check yourself.
                          The session is saved (owner-only) for later runs.
  add -- <link|file|dir>  Queue reels: reel/post links, a chat link (https://www.instagram.com/direct/t/<id>/,
                          queues every reel and post shared in it), a text file of links, or your Instagram
                          "Download your information" export folder (authorised chats only).
                          --from "<name>"  record who shared manually added links.
  auto [-- --dry-run]     Comment on every queued reel by itself with one of COMMENT_PHRASES, at least
                          COMMENT_GAP_SECONDS apart, at most DAILY_LIMIT a day and AUTHOR_DAILY_LIMIT
                          a day on the same account's posts.
  review [-- --dry-run]   Open queued reels, draft a comment for each, and ask you to approve it.
  status                  Show the queue and recent decisions.

Dry run is on unless DRY_RUN=false. Ctrl+C stops after the current step (twice to exit at once).`;

// ----- Stop mechanism: Ctrl+C / SIGTERM finishes the current step, a second Ctrl+C exits at once.
const stop = new AbortController();
function requestStop(): void {
    if (stop.signal.aborted) {
        log.warn('Second interrupt - exiting now.');
        process.exit(130);
    }
    stop.abort();
    log.warn('Stopping after the current step (press Ctrl+C again to exit immediately).');
}
process.on('SIGINT', requestStop);
process.on('SIGTERM', requestStop);

let terminal: Interface | undefined;
function prompts(): Interface {
    if (!terminal) {
        terminal = createInterface({ input: process.stdin, output: process.stdout });
        terminal.on('SIGINT', requestStop); // while a prompt is open, Ctrl+C arrives here instead
    }
    return terminal;
}

const isAbort = (e: unknown) => (e as Error)?.name === 'AbortError';

const startOfToday = () => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    return midnight.toISOString();
};

/** `done` aborts when the login code sees the page move on; Enter or Ctrl+C also end the wait. */
async function waitForHuman(instructions: string, done: AbortSignal): Promise<void> {
    log.warn(instructions);
    const signal = AbortSignal.any([stop.signal, done]);
    try {
        if (process.stdin.isTTY) await prompts().question('Press Enter when done (or just finish in the browser) > ', { signal });
        else await sleep(2 ** 31 - 1, undefined, { signal }); // no keyboard attached: wait for the browser
    } catch (e) {
        if (!done.aborted) throw e;
        if (process.stdin.isTTY) process.stdout.write('\n');
    }
}

function sessionOptions(headless: boolean) {
    if (!config.username) throw new BotError('CONFIG', 'Set IG_USERNAME in .env first (see .env.example).');
    return {
        username: config.username,
        password: config.password,
        headless,
        // A person can only help when the browser window is visible.
        waitForHuman: headless ? undefined : waitForHuman,
        sessionFile: config.sessionFile,
        screenshotDir: logsDir,
        logger: new Logger(config.username),
    };
}

// ----- login

async function cmdLogin(): Promise<void> {
    const session = await openSession(sessionOptions(false));
    await session.browser.close();
    log.success(`Logged in as @${config.username}. Session saved (owner-only) to ${path.relative(process.cwd(), config.sessionFile)}.`);
}

// ----- add

function printThreads(threads: ExportThread[]): void {
    const withLinks = threads.filter(thread => thread.links > 0);
    if (!withLinks.some(thread => thread.authorized)) {
        log.warn('No conversation in this export is authorised. Put the ones you want processed in AUTHORIZED_THREADS in .env (folder name or title, comma-separated) and run add again.');
    }
    for (const thread of withLinks) {
        const label = thread.authorized ? chalk.green('authorised    ') : chalk.gray('not authorised');
        console.log(`  ${label}  ${thread.title}  (${thread.folder}, ${thread.links} link${thread.links === 1 ? '' : 's'})`);
    }
}

/** Every reel/post shared in a chat, read with the saved session. */
async function readChat(url: string): Promise<InputResult> {
    const session = await openSession(sessionOptions(config.headless));
    try {
        log.action(`Reading ${url}: scrolling up through the whole chat, this can take a few minutes...`);
        const items = await readThread(session.page, url, { signal: stop.signal, logger: log }).catch(async e => {
            await session.page.screenshot({ path: path.join(logsDir, 'chat_error.png') }).catch(() => {});
            throw e;
        });
        if (items.length === 0) {
            const shot = path.join(logsDir, 'chat_no_links.png');
            await session.page.screenshot({ path: shot }).catch(() => {});
            log.warn(
                `No reel or post links found in that chat. If it does have shared reels, Instagram's chat page has probably changed; screenshot: ${path.relative(process.cwd(), shot)}`,
                'UNKNOWN_PAGE'
            );
        }
        return { source: 'dm-thread', items };
    } finally {
        await session.browser.close();
    }
}

async function cmdAdd(args: string[]): Promise<void> {
    const { values, positionals } = parseArgs({ args, options: { from: { type: 'string' } }, allowPositionals: true });
    if (positionals.length === 0) {
        throw new BotError('INPUT', 'Nothing to add. Example: npm run add -- https://www.instagram.com/reel/XXXXXXXXXXX/');
    }
    const db = new ReelStore(config.dbFile);
    for (const input of positionals) {
        if (stop.signal.aborted) break;
        const chat = threadUrl(input);
        const { source, items, threads } = chat ? await readChat(chat) : readInput(input, config.authorizedThreads);
        const tally = { added: 0, requeued: 0, duplicate: 0 };
        for (const item of items) tally[db.add({ ...item, shared_by: item.shared_by ?? values.from }, source)]++;
        if (threads) printThreads(threads);
        log.success(`${input}: ${tally.added} added, ${tally.requeued} re-queued, ${tally.duplicate} already known.`);
    }
}

// ----- opening reels (review and auto)

/** Waits until `seconds` have passed since `since` (epoch ms); Ctrl+C cuts the wait short. */
async function waitGap(since: number, seconds: number, what: string): Promise<void> {
    const wait = since + seconds * 1000 - Date.now();
    if (wait <= 0) return;
    log.info(`Pacing: ${what} in ${Math.ceil(wait / 1000)}s.`);
    await sleep(wait, undefined, { signal: stop.signal });
}

/**
 * Opens a queued reel. Unavailable or private reels are recorded through `save` and give undefined;
 * problems that affect every reel are thrown so the run stops.
 */
async function openQueued(page: Page, row: ReelRow, save: Save): Promise<Extract<ReelInfo, { status: 'ok' }> | undefined> {
    log.action(`Opening ${row.url}`);
    let info: ReelInfo;
    try {
        info = await openReel(page, row.url);
    } catch (e) {
        if (e instanceof BotError && e.category === 'UNKNOWN_PAGE') {
            // ponytail: one unrecognised page stops the run - likely a layout change affecting every reel.
            save({ status: 'failed', error: `${e.category}: ${e.message}` });
            await page.screenshot({ path: path.join(logsDir, `reel_${row.shortcode}.png`) }).catch(() => {});
        }
        throw e; // session / checkpoint / rate-limit / network problems leave the reel queued
    }
    if (info.status === 'ok') return info;
    const category: ErrorCategory = info.status === 'private' ? 'PRIVATE' : 'UNAVAILABLE';
    const why = info.status === 'private' ? 'private account you cannot see' : 'deleted or unavailable';
    save({ status: 'unavailable', processed_at: new Date().toISOString(), error: `${category}: ${why}` });
    log.warn(`${row.url}: ${why} - skipped.`, category);
    return undefined;
}

// ----- review

async function handOff(db: ReelStore, row: ReelRow, comment: string): Promise<void> {
    const outcome = await handOffForPosting(prompts(), row.url, comment, stop.signal);
    if (outcome === 'posted') {
        db.update(row.shortcode, { status: 'submitted', submitted_at: new Date().toISOString(), submission: 'posted manually (confirmed by you)' });
        log.success('Recorded as posted.');
    } else if (outcome === 'skipped') {
        db.update(row.shortcode, { status: 'skipped', submission: 'not posted (skipped at hand-off)' });
        log.info('Skipped.');
    } else {
        log.info('Kept as approved; the next live review offers it again.');
    }
}

/** Asks for a decision on a drafted reel. Returns false when you chose to quit. */
async function decide(db: ReelStore, row: ReelRow, ai: AICommentGenerator | undefined, dryRun: boolean, imageUrl?: string): Promise<boolean> {
    const draft = () =>
        ai!.generateInstagramComment(row.caption ?? '', row.author ?? undefined, config.aiPromptHint, imageUrl, db.recentComments(10));
    const decision = await askApproval(prompts(), row, row.proposed_comment ?? '', {
        regenerate: ai && draft,
        recent: db.recentComments(20),
        signal: stop.signal,
    });
    if (decision.action === 'quit') return false;
    const decided_at = new Date().toISOString();
    if (decision.action === 'skip') {
        db.update(row.shortcode, { status: 'skipped', decided_at });
        log.info('Skipped.');
        return true;
    }
    db.update(row.shortcode, { status: 'approved', final_comment: decision.comment, decided_at });
    if (dryRun) {
        log.success('Approved (dry run): recorded only - nothing opened, nothing posted.');
        return true;
    }
    await handOff(db, row, decision.comment);
    return true;
}

async function cmdReview(args: string[]): Promise<void> {
    const { values } = parseArgs({ args, options: { 'dry-run': { type: 'boolean' } } });
    const dryRun = config.dryRun || values['dry-run'] === true;
    const db = new ReelStore(config.dbFile);
    const ai = config.geminiApiKey ? new AICommentGenerator(config.geminiApiKey, config.geminiModel) : undefined;
    log.header(
        dryRun
            ? '----- Review: DRY RUN (approvals are recorded; nothing is opened for posting) -----'
            : '----- Review: LIVE (approved comments are handed to you to post yourself) -----'
    );
    if (!ai) log.warn('GEMINI_API_KEY is not set - you will write each comment yourself.', 'CONFIG');

    let session: Session | undefined;
    try {
        // 1. Approved in an earlier run but not posted yet (live runs only).
        if (!dryRun) {
            for (const row of db.list('approved')) {
                if (stop.signal.aborted) return;
                console.log(describeReel(row));
                console.log(`${chalk.bold('Approved comment:')} ${chalk.greenBright(row.final_comment ?? '')}`);
                await handOff(db, row, row.final_comment ?? '');
            }
        }
        // 2. Drafted in an earlier (interrupted) run, still waiting for a decision.
        for (const row of db.list('proposed')) {
            if (stop.signal.aborted || !(await decide(db, row, ai, dryRun))) return;
        }
        // 3. New reels.
        let lastLoad = 0;
        for (let row = db.next('queued'); row && !stop.signal.aborted; row = db.next('queued')) {
            const used = db.processedSince(startOfToday());
            if (used >= config.dailyLimit) {
                log.warn(`Daily limit reached (${used}/${config.dailyLimit}); the rest stays queued for tomorrow.`);
                break;
            }
            session ??= await openSession(sessionOptions(config.headless));
            await waitGap(lastLoad, config.actionDelaySeconds, 'next page load'); // time spent reviewing counts toward it
            lastLoad = Date.now();
            const info = await openQueued(session.page, row, fields => db.update(row.shortcode, fields));
            if (!info) continue;

            const processed_at = new Date().toISOString();
            // The page is authoritative for the author; the DM export's "original owner" is the fallback.
            const author = info.author ?? row.author;
            const caption = info.caption ?? row.caption;
            if (row.author && info.author && row.author !== info.author) {
                log.info(`The export said @${row.author}; the page says @${info.author}. Using the page.`);
            }
            let draft = '';
            if (ai) {
                try {
                    draft = await ai.generateInstagramComment(caption ?? '', author ?? undefined, config.aiPromptHint, info.imageUrl, db.recentComments(10));
                } catch (e) {
                    log.warn(firstLine(e), 'AI');
                }
            }
            db.update(row.shortcode, { status: 'proposed', author, caption, proposed_comment: draft || null, processed_at });
            const drafted: ReelRow = { ...row, status: 'proposed', author, caption, proposed_comment: draft || null, processed_at };
            if (!(await decide(db, drafted, ai, dryRun, info.imageUrl))) break;
        }
    } catch (e) {
        if (!isAbort(e)) throw e;
    } finally {
        await session?.browser.close();
    }
    log.info('Review finished. See "npm run status" for the record.');
}

// ----- auto

async function cmdAuto(args: string[]): Promise<void> {
    const { values } = parseArgs({ args, options: { 'dry-run': { type: 'boolean' } } });
    const dryRun = config.dryRun || values['dry-run'] === true;
    const db = new ReelStore(config.dbFile);
    log.header(
        dryRun
            ? '----- Auto: DRY RUN (each comment is typed and cleared again; nothing is posted or recorded) -----'
            : `----- Auto: LIVE (posting comments by itself, at least ${config.commentGapSeconds}s apart) -----`
    );
    // Comments you approved in a review go first. Ones marked "posting" were interrupted mid-post and
    // may be live already, so they are never retried automatically.
    const pending = [...db.list('approved').filter(row => !row.submission), ...db.list('queued')];
    log.info(`${pending.length} reel(s) waiting. Phrases: ${config.commentPhrases.join(' | ')}`);
    let budget = config.dailyLimit - db.processedSince(startOfToday());
    let last = db.recentComments(1)[0];
    let lastLoad = 0;
    let session: Session | undefined;
    // Comments per account today: from the database, then counted in this run (a dry run records nothing).
    const today = startOfToday();
    const perAuthor = new Map<string, number>();
    const commentsOn = (author: string) => perAuthor.get(author) ?? db.commentsOnAuthorSince(author, today);
    const heldBack = (row: ReelRow, author: string | null | undefined) => {
        if (!author || commentsOn(author) < config.authorDailyLimit) return false;
        log.info(`${row.url} (@${author}): already ${config.authorDailyLimit} comment(s) on their posts today (AUTHOR_DAILY_LIMIT) - left for another day.`);
        return true;
    };
    try {
        for (const row of pending) {
            if (stop.signal.aborted) break;
            if (heldBack(row, row.author)) continue; // author known from an earlier run: no need to open it
            if (budget-- <= 0) {
                log.warn(`Daily limit reached (DAILY_LIMIT=${config.dailyLimit}); the rest stays queued for tomorrow.`);
                break;
            }
            const lastPost = db.lastSubmittedAt();
            if (!dryRun && lastPost) await waitGap(Date.parse(lastPost), config.commentGapSeconds, 'next comment');
            session ??= await openSession(sessionOptions(config.headless));
            await waitGap(lastLoad, config.actionDelaySeconds, 'next page load');
            lastLoad = Date.now();

            const save: Save = dryRun ? () => {} : fields => db.update(row.shortcode, fields);
            const info = await openQueued(session.page, row, save);
            if (!info) continue;
            const author = info.author ?? row.author;
            const caption = info.caption ?? row.caption;
            if (heldBack(row, author)) {
                save({ author, caption }); // stays queued; next time it is held back without opening it
                continue;
            }
            const fresh = row.status === 'queued' || !row.final_comment;
            const comment = fresh ? pickPhrase(config.commentPhrases, last) : row.final_comment!;
            const now = new Date().toISOString();
            save({ author, caption, processed_at: now, ...(fresh ? { proposed_comment: comment, decided_at: now } : {}) });

            let outcome: CommentOutcome;
            try {
                outcome = dryRun ? await postComment(session.page, comment, { dryRun }) : await postAndRecord(session.page, comment, save);
            } catch (e) {
                await session.page.screenshot({ path: path.join(logsDir, `comment_${row.shortcode}.png`) }).catch(() => {});
                throw e;
            }
            const where = `${row.url}${info.author ? ` (@${info.author})` : ''}`;
            if (outcome === 'comments_off') {
                log.info(`${where}: comments are turned off - skipped.`);
                continue;
            }
            if (outcome === 'unconfirmed') {
                throw new BotError('COMMENT_FAILED', `Clicked Post on ${where}, but the comment did not show up. Check the reel; it will not be retried. Stopping.`);
            }
            if (author) perAuthor.set(author, commentsOn(author) + 1);
            last = comment;
            log.success(dryRun ? `Dry run: would post "${comment}" on ${where}.` : `Posted "${comment}" on ${where}.`);
        }
    } catch (e) {
        if (!isAbort(e)) throw e;
    } finally {
        await session?.browser.close();
    }
    log.info('Auto run finished. See "npm run status" for the record.');
}

// ----- status

function cmdStatus(): void {
    const db = new ReelStore(config.dbFile);
    const counts = db.counts();
    log.header('----- Queue -----');
    if (counts.length === 0) {
        log.info('Nothing queued yet. Add reels with: npm run add -- <url | file | export folder>');
        return;
    }
    console.log(counts.map(c => `${c.status}: ${c.n}`).join('   '));
    log.header('----- Most recent -----');
    for (const row of db.recent(15)) {
        const when = new Date(row.submitted_at ?? row.decided_at ?? row.processed_at ?? row.queued_at).toLocaleString();
        const who = row.author ? `  @${row.author}` : '';
        const comment = row.final_comment ? `  "${row.final_comment}"` : '';
        const error = row.error ? chalk.gray(`  ${row.error}`) : '';
        console.log(`${when}  ${row.status.padEnd(11)} ${row.url}${who}${comment}${error}`);
    }
    log.info(`Today: ${db.processedSince(startOfToday())}/${config.dailyLimit} reels processed. Database: ${path.relative(process.cwd(), config.dbFile)}`);
}

// ----- entry point

const commands: Record<string, (args: string[]) => unknown> = {
    login: cmdLogin,
    add: cmdAdd,
    auto: cmdAuto,
    review: cmdReview,
    status: cmdStatus,
};

(async () => {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.chmodSync(dataDir, 0o700); // holds the session cookies
    Logger.file = path.join(logsDir, 'bot.jsonl');
    registerSecret(config.password);
    registerSecret(config.geminiApiKey);

    const [name, ...args] = process.argv.slice(2);
    const command = name ? commands[name] : undefined;
    if (!command) {
        console.log(USAGE);
        if (name) process.exitCode = 1;
        return;
    }
    await command(args);
})()
    .catch(e => {
        if (isAbort(e)) return;
        if (e instanceof BotError) log.error(e.message, e.category);
        else log.error(`Unexpected error: ${e?.stack ?? e}`);
        process.exitCode = 1;
    })
    .finally(() => terminal?.close());
