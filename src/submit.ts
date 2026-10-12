import { execFile, execFileSync } from 'child_process';
import { Interface } from 'readline/promises';

export type HandOffOutcome = 'posted' | 'later' | 'skipped';

/**
 * Review mode: hands an approved comment to you to post. This never clicks "Post" itself: it opens the
 * reel in your browser, puts the comment on the clipboard, and records what you report back.
 * (Auto mode, which does post by itself, is in comment.ts.)
 */
export async function handOffForPosting(
    rl: Pick<Interface, 'question'>,
    url: string,
    comment: string,
    signal: AbortSignal
): Promise<HandOffOutcome> {
    if (process.platform === 'darwin') {
        execFileSync('pbcopy', { input: comment });
        execFile('open', [url]);
        console.log('Opened the reel in your default browser and copied the comment to the clipboard.');
        console.log('Paste it into the comment box, check it, and post it yourself.');
    } else {
        console.log(`Open ${url} and post this comment yourself:\n  ${comment}`);
    }
    const answer = (await rl.question('Did you post it? [y]es / [n]o, keep it for later / [s]kip this reel > ', { signal })).trim().toLowerCase();
    if (answer === 'y') return 'posted';
    return answer === 's' ? 'skipped' : 'later';
}
