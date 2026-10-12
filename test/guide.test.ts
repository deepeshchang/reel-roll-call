import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMENT_GUIDE, GENERAL, guidePhrase, pickPhrase } from '../src/guide';

describe('comment guide', () => {
    test('every phrase follows the rule: 2 words + 1 emoji', () => {
        for (const phrase of [...COMMENT_GUIDE.flatMap(entry => entry.phrases), ...GENERAL]) {
            assert.match(phrase, /^\p{L}+ \p{L}+ \p{Extended_Pictographic}️?$/u, phrase);
        }
    });

    test("picks from the reel's category, and the general phrases when the category is unknown", () => {
        const food = COMMENT_GUIDE.find(entry => entry.category === 'Food Content')!;
        assert.ok(food.phrases.includes(guidePhrase(food, [])));
        assert.ok(GENERAL.includes(guidePhrase(undefined, [])));
    });
});

describe('pickPhrase', () => {
    test('avoids the recently used phrases when there is a choice', () => {
        for (let i = 0; i < 20; i++) assert.equal(pickPhrase(['A', 'B', 'C'], ['A', 'B']), 'C');
    });

    test('still returns a phrase when all of them were used recently', () => {
        assert.ok(['A', 'B'].includes(pickPhrase(['A', 'B'], ['A', 'B'])));
    });
});
