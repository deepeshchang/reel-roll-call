import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { ReelStore } from '../src/db';

const reel = (shortcode: string, kind = 'reel') => ({ shortcode, url: `https://www.instagram.com/${kind}/${shortcode}/` });

describe('ReelStore', () => {
    test('adds a reel once; the same shortcode again is a duplicate, even as a /p/ link', () => {
        const db = new ReelStore(':memory:');
        assert.equal(db.add(reel('AAA111'), 'manual'), 'added');
        assert.equal(db.add(reel('AAA111', 'p'), 'file:list.txt'), 'duplicate');
        assert.equal(db.list('queued').length, 1);
    });

    test('never queues a reel again once it has been handled', () => {
        const db = new ReelStore(':memory:');
        db.add(reel('AAA111'), 'manual');
        db.update('AAA111', { status: 'submitted', final_comment: 'Loved this perspective.' });
        assert.equal(db.add(reel('AAA111'), 'manual'), 'duplicate');
        assert.equal(db.next('queued'), undefined);
    });

    test('re-adding a failed reel puts it back in the queue and clears the error', () => {
        const db = new ReelStore(':memory:');
        db.add(reel('AAA111'), 'manual');
        db.update('AAA111', { status: 'failed', error: 'UNKNOWN_PAGE: nothing recognisable' });
        assert.equal(db.add(reel('AAA111'), 'manual'), 'requeued');
        const row = db.next('queued');
        assert.equal(row?.shortcode, 'AAA111');
        assert.equal(row?.error, null);
    });

    test('hands out queued reels in the order they were added', () => {
        const db = new ReelStore(':memory:');
        for (const code of ['CCC333', 'AAA111', 'BBB222']) db.add(reel(code), 'manual');
        assert.equal(db.next('queued')?.shortcode, 'CCC333');
        db.update('CCC333', { status: 'proposed' });
        assert.equal(db.next('queued')?.shortcode, 'AAA111');
    });

    test('keeps provenance: conversation, who shared it, and the real author', () => {
        const db = new ReelStore(':memory:');
        db.add(
            { ...reel('DePb6WLuVae'), conversation: 'Alíce', shared_by: 'Alíce', shared_at: '2025-10-09T08:53:20.000Z', author: 'instagram', caption: 'café vibes' },
            'dm-export'
        );
        const row = db.next('queued');
        assert.deepEqual(
            [row?.source, row?.conversation, row?.shared_by, row?.shared_at, row?.author, row?.caption],
            ['dm-export', 'Alíce', 'Alíce', '2025-10-09T08:53:20.000Z', 'instagram', 'café vibes']
        );
    });

    test('lists the reels queued from one chat, so reading it again can stop there', () => {
        const db = new ReelStore(':memory:');
        db.add({ ...reel('AAA111'), conversation: 'https://www.instagram.com/direct/t/1/' }, 'dm-thread');
        db.add({ ...reel('BBB222'), conversation: 'https://www.instagram.com/direct/t/2/' }, 'dm-thread');
        db.add(reel('CCC333'), 'manual');
        assert.deepEqual(db.shortcodesFrom('https://www.instagram.com/direct/t/1/'), new Set(['AAA111']));
    });

    test('counts reels processed since a cut-off, for the daily limit', () => {
        const db = new ReelStore(':memory:');
        for (const code of ['AAA111', 'BBB222', 'CCC333']) db.add(reel(code), 'manual');
        db.update('AAA111', { processed_at: '2026-10-11T23:59:59.000Z' });
        db.update('BBB222', { processed_at: '2026-10-12T00:00:00.000Z' });
        db.update('CCC333', { processed_at: '2026-10-12T09:30:00.000Z' });
        assert.equal(db.processedSince('2026-10-12T00:00:00.000Z'), 2);
    });

    test('remembers when the last comment went out, for the gap between comments', () => {
        const db = new ReelStore(':memory:');
        assert.equal(db.lastSubmittedAt(), undefined);
        for (const code of ['AAA111', 'BBB222', 'CCC333']) db.add(reel(code), 'manual');
        db.update('AAA111', { status: 'submitted', submitted_at: '2026-10-12T09:03:00.000Z' });
        db.update('BBB222', { status: 'submitted', submitted_at: '2026-10-12T09:00:00.000Z' });
        assert.equal(db.lastSubmittedAt(), '2026-10-12T09:03:00.000Z');
    });

    test("counts today's comments on one account's posts, for the per-account limit", () => {
        const db = new ReelStore(':memory:');
        for (const code of ['AAA111', 'BBB222', 'CCC333', 'DDD444']) db.add(reel(code), 'manual');
        db.update('AAA111', { author: 'creator', status: 'submitted', submitted_at: '2026-10-11T23:59:59.000Z' });
        db.update('BBB222', { author: 'creator', status: 'submitted', submitted_at: '2026-10-12T09:00:00.000Z' });
        db.update('CCC333', { author: 'someone_else', status: 'submitted', submitted_at: '2026-10-12T09:03:00.000Z' });
        db.update('DDD444', { author: 'creator', processed_at: '2026-10-12T09:06:00.000Z' }); // opened, not commented
        assert.equal(db.commentsOnAuthorSince('creator', '2026-10-12T00:00:00.000Z'), 1);
    });

    test('returns approved comments newest first, so the AI can avoid repeating them', () => {
        const db = new ReelStore(':memory:');
        for (const code of ['AAA111', 'BBB222', 'CCC333']) db.add(reel(code), 'manual');
        db.update('AAA111', { final_comment: 'Great content!', decided_at: '2026-10-10T10:00:00.000Z' });
        db.update('BBB222', { final_comment: 'Nice reel <3', decided_at: '2026-10-12T10:00:00.000Z' });
        assert.deepEqual(db.recentComments(5), ['Nice reel <3', 'Great content!']);
    });

    test('rejects a status outside the known set', () => {
        const db = new ReelStore(':memory:');
        db.add(reel('AAA111'), 'manual');
        assert.throws(() => db.update('AAA111', { status: 'posted' as never }), /CHECK constraint/);
    });

    test('adds the liked_at column to a database created before likes existed', () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ig-db-')), 'reels.db');
        const old = new DatabaseSync(file);
        old.exec(`CREATE TABLE reels (shortcode TEXT PRIMARY KEY, url TEXT NOT NULL, source TEXT NOT NULL, conversation TEXT,
            shared_by TEXT, shared_at TEXT, author TEXT, caption TEXT, status TEXT NOT NULL DEFAULT 'queued', proposed_comment TEXT,
            final_comment TEXT, submission TEXT, error TEXT, queued_at TEXT NOT NULL, processed_at TEXT, decided_at TEXT, submitted_at TEXT)`);
        old.close();
        const db = new ReelStore(file);
        db.add(reel('AAA111'), 'manual');
        db.update('AAA111', { liked_at: '2026-10-13T01:00:00.000Z' });
        assert.equal(db.next('queued')?.liked_at, '2026-10-13T01:00:00.000Z');
    });

    test('creates the database file readable by the owner only', () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ig-db-')), 'nested', 'reels.db');
        new ReelStore(file);
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    });
});
