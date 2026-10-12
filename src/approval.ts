import chalk from 'chalk';
import { Interface } from 'readline/promises';
import { ReelRow } from './db';

export type Decision = { action: 'approve'; comment: string } | { action: 'skip' } | { action: 'quit' };

const MAX_COMMENT_LENGTH = 2200; // Instagram's limit

/** Captions and AI output are untrusted: drop control characters so they can't drive the terminal. */
export const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();

export function describeReel(row: ReelRow): string {
    const caption = row.caption ? clean(row.caption) : '';
    const lines = [chalk.bold(`\n─── ${row.url}`), `Author:    ${row.author ? `@${clean(row.author)}` : chalk.gray('unknown')}`];
    if (row.shared_by || row.conversation) {
        const where = row.conversation ? ` in "${clean(row.conversation)}"` : '';
        const when = row.shared_at ? ` on ${new Date(row.shared_at).toLocaleDateString()}` : '';
        lines.push(`Shared by: ${row.shared_by ? clean(row.shared_by) : 'unknown'}${where}${when}`);
    }
    lines.push(`Caption:   ${caption ? (caption.length > 300 ? `${caption.slice(0, 300)}…` : caption) : chalk.gray('(none)')}`);
    return lines.join('\n');
}

export function validateComment(comment: string): string | null {
    if (!comment.trim()) return 'The comment is empty - press e to write one.';
    if (comment.length > MAX_COMMENT_LENGTH) return `Instagram comments are limited to ${MAX_COMMENT_LENGTH} characters.`;
    return null;
}

/** Shows the reel and the draft. Only an explicit "a" on a valid comment approves; anything else re-asks. */
export async function askApproval(
    rl: Pick<Interface, 'question' | 'write'>,
    row: ReelRow,
    draft: string,
    opts: { regenerate?: () => Promise<string>; recent: string[]; signal: AbortSignal }
): Promise<Decision> {
    console.log(describeReel(row));
    let comment = clean(draft);
    for (;;) {
        console.log(`${chalk.bold('Proposed comment:')} ${comment ? chalk.greenBright(comment) : chalk.gray('(none)')}`);
        if (comment && opts.recent.some(previous => previous.toLowerCase() === comment.toLowerCase())) {
            console.log(chalk.yellow('You approved this exact comment recently - consider editing it.'));
        }
        const menu = `[a]pprove  [e]dit  ${opts.regenerate ? '[r]egenerate  ' : ''}[s]kip  [q]uit > `;
        const answer = (await rl.question(menu, { signal: opts.signal })).trim().toLowerCase();
        if (answer === 'a') {
            const problem = validateComment(comment);
            if (!problem) return { action: 'approve', comment };
            console.log(chalk.yellow(problem));
        } else if (answer === 'e') {
            const edited = rl.question('Comment: ', { signal: opts.signal });
            rl.write(comment); // pre-fill the current draft for editing
            comment = clean(await edited);
        } else if (answer === 'r' && opts.regenerate) {
            try {
                comment = clean(await opts.regenerate());
            } catch (e) {
                console.log(chalk.yellow(String((e as Error).message ?? e)));
            }
        } else if (answer === 's') {
            return { action: 'skip' };
        } else if (answer === 'q') {
            return { action: 'quit' };
        }
    }
}
