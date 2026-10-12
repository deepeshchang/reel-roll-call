import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { askApproval } from '../src/approval';
import { ReelRow } from '../src/db';

const row: ReelRow = {
    shortcode: 'DePb6WLuVae',
    url: 'https://www.instagram.com/reel/DePb6WLuVae/',
    source: 'dm-export',
    conversation: 'Alíce',
    shared_by: 'Alíce',
    shared_at: '2025-10-09T08:53:20.000Z',
    author: 'instagram',
    caption: 'fur real\u001b[2J every single one of these is the best one',
    status: 'proposed',
    proposed_comment: null,
    final_comment: null,
    submission: null,
    error: null,
    queued_at: '2026-10-12T09:00:00.000Z',
    processed_at: '2026-10-12T09:01:00.000Z',
    decided_at: null,
    submitted_at: null,
    liked_at: null,
};

/** Stands in for the terminal: answers each prompt from a script and records what was asked. */
function scriptedTerminal(answers: string[]) {
    const asked: string[] = [];
    let prefill = '';
    return {
        asked,
        rl: {
            question: async (prompt: string) => {
                asked.push(prompt);
                await null; // like readline, answer later - after any rl.write() pre-fill
                const answer = answers.shift();
                if (answer === undefined) throw new Error(`unexpected prompt: ${prompt}`);
                const value = prompt.startsWith('Comment:') ? answer.replace('{prefill}', prefill) : answer;
                prefill = '';
                return value;
            },
            write: (text: string) => {
                prefill = text;
            },
        },
    };
}

const quietly = async <T>(fn: () => Promise<T>): Promise<T> => {
    const log = console.log;
    console.log = () => {};
    try {
        return await fn();
    } finally {
        console.log = log;
    }
};

describe('askApproval', () => {
    const signal = new AbortController().signal;

    test('approves only on an explicit "a"; unknown answers just ask again', async () => {
        const { rl, asked } = scriptedTerminal(['', 'yes', 'A']);
        const decision = await quietly(() => askApproval(rl as never, row, 'Loved this perspective.', { recent: [], signal }));
        assert.deepEqual(decision, { action: 'approve', comment: 'Loved this perspective.' });
        assert.equal(asked.length, 3);
    });

    test('refuses to approve an empty draft until a comment is written', async () => {
        const { rl } = scriptedTerminal(['a', 'e', 'Great content!', 'a']);
        const decision = await quietly(() => askApproval(rl as never, row, '', { recent: [], signal }));
        assert.deepEqual(decision, { action: 'approve', comment: 'Great content!' });
    });

    test('editing starts from the current draft', async () => {
        const { rl } = scriptedTerminal(['e', '{prefill} Thanks for sharing.', 'a']);
        const decision = await quietly(() => askApproval(rl as never, row, 'Nice reel <3', { recent: [], signal }));
        assert.deepEqual(decision, { action: 'approve', comment: 'Nice reel <3 Thanks for sharing.' });
    });

    test('regenerate replaces the draft with a fresh one', async () => {
        const { rl } = scriptedTerminal(['r', 'a']);
        const decision = await quietly(() =>
            askApproval(rl as never, row, 'Great content!', { regenerate: async () => 'Those paws deserve their own reel.', recent: [], signal })
        );
        assert.deepEqual(decision, { action: 'approve', comment: 'Those paws deserve their own reel.' });
    });

    test('skip and quit are distinct decisions', async () => {
        assert.deepEqual(await quietly(() => askApproval(scriptedTerminal(['s']).rl as never, row, 'x', { recent: [], signal })), { action: 'skip' });
        assert.deepEqual(await quietly(() => askApproval(scriptedTerminal(['q']).rl as never, row, 'x', { recent: [], signal })), { action: 'quit' });
    });

    test('strips terminal control sequences from untrusted captions before printing', async () => {
        const printed: string[] = [];
        const log = console.log;
        console.log = (...parts: unknown[]) => void printed.push(parts.join(' '));
        try {
            await askApproval(scriptedTerminal(['s']).rl as never, row, 'x', { recent: [], signal });
        } finally {
            console.log = log;
        }
        assert.ok(!printed.join('\n').includes('\u001b[2J'));
    });
});
