import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AICommentGenerator } from '../src/genai';
import { BotError } from '../src/logger';

/** An AICommentGenerator whose model always replies `answer` - no network. Records the prompts. */
function modelAnswering(answer: string) {
    const generator = new AICommentGenerator('test-key', 'test-model');
    const prompts: string[] = [];
    (generator as unknown as { ai: object }).ai = {
        models: {
            generateContent: async ({ contents }: { contents: { text?: string }[] }) => {
                prompts.push(contents.map(part => part.text ?? '').join(''));
                return { candidates: [{ content: { parts: [{ text: answer }] } }] };
            },
        },
    };
    return { generator, prompts };
}

describe('AICommentGenerator.categorize', () => {
    test('returns the category the model picks by number', async () => {
        const { generator, prompts } = modelAnswering('3');
        assert.equal(await generator.categorize('pasta night', undefined, ['Editing', 'Fashion', 'Food']), 2);
        assert.match(prompts[0], /1\. Editing\n2\. Fashion\n3\. Food/);
    });

    test('raises AI when the answer is not one of the numbers', async () => {
        for (const answer of ['Probably food?', '7']) {
            const { generator } = modelAnswering(answer);
            await assert.rejects(generator.categorize('', undefined, ['Editing', 'Food']), (e: unknown) => e instanceof BotError && e.category === 'AI', answer);
        }
    });
});
