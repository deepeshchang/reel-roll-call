import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalize, extractRefs, readDmExport, readInput } from '../src/ingest';

describe('canonicalize', () => {
    const cases: [string, string | null][] = [
        ['https://www.instagram.com/reel/DePb6WLuVae/?igsh=MWQ1ZGUxMzBkMA==', 'https://www.instagram.com/reel/DePb6WLuVae/'],
        ['https://www.instagram.com/instagram/reel/DePb6WLuVae/?hl=en', 'https://www.instagram.com/reel/DePb6WLuVae/'],
        ['https://instagram.com/p/Cx_yz-12AB/', 'https://www.instagram.com/p/Cx_yz-12AB/'],
        ['https://www.instagram.com/reels/DePb6WLuVae/', 'https://www.instagram.com/reel/DePb6WLuVae/'],
        ['https://m.instagram.com/tv/B1234567890/', 'https://www.instagram.com/p/B1234567890/'],
        ['http://instagr.am/p/BAbc123/', 'https://www.instagram.com/p/BAbc123/'],
        ['instagram.com/reel/DePb6WLuVae', 'https://www.instagram.com/reel/DePb6WLuVae/'],
        ['https://www.instagram.com/stories/someone/3456/', null],
        ['https://www.instagram.com/someone/', null],
        ['https://www.instagram.com/share/reel/BAqk2abcde/', null],
        ['https://www.instagram.com.evil.example/reel/DePb6WLuVae/', null],
        ['https://example.com/reel/DePb6WLuVae/', null],
        ['not a url', null],
    ];
    for (const [input, want] of cases) {
        test(`${input} -> ${want}`, () => assert.equal(canonicalize(input)?.url ?? null, want));
    }

    test('keys items by shortcode, so /p/X and /reel/X are the same reel', () => {
        assert.equal(canonicalize('https://www.instagram.com/p/DePb6WLuVae/')?.shortcode, 'DePb6WLuVae');
        assert.equal(canonicalize('https://www.instagram.com/reel/DePb6WLuVae/')?.shortcode, 'DePb6WLuVae');
    });
});

test('extractRefs pulls every reel/post link out of free text, de-duplicated, in order', () => {
    const text = `look https://www.instagram.com/reel/AAA111/?igsh=x and this
        https://instagram.com/p/BBB222/ (again: https://www.instagram.com/reel/AAA111/) plus https://youtube.com/watch?v=1`;
    assert.deepEqual(
        extractRefs(text).map(ref => ref.url),
        ['https://www.instagram.com/reel/AAA111/', 'https://www.instagram.com/p/BBB222/']
    );
});

// Shape of Instagram's "Download your information" JSON export, including its habit of storing UTF-8
// bytes as \u00XX escapes ("Alíce" arrives as "AlÃ­ce").
function writeExport(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-export-'));
    const inbox = path.join(root, 'your_instagram_activity', 'messages', 'inbox');
    const thread = (folder: string, data: object) => {
        fs.mkdirSync(path.join(inbox, folder), { recursive: true });
        fs.writeFileSync(path.join(inbox, folder, 'message_1.json'), JSON.stringify(data));
    };
    thread('alice_1234567890', {
        participants: [{ name: 'AlÃ­ce' }, { name: 'Me' }],
        messages: [
            { sender_name: 'AlÃ­ce', timestamp_ms: 1760000200000, content: 'haha', is_geoblocked_for_viewer: false },
            { sender_name: 'Me', timestamp_ms: 1760000100000, content: 'also https://instagram.com/p/Cx_yz-12AB/ lol', is_geoblocked_for_viewer: false },
            {
                sender_name: 'AlÃ­ce',
                timestamp_ms: 1760000000000,
                content: 'AlÃ­ce sent an attachment.',
                share: { link: 'https://www.instagram.com/reel/DePb6WLuVae/?igsh=abc', share_text: 'cafÃ© vibes', original_content_owner: 'instagram' },
                is_geoblocked_for_viewer: false,
            },
        ],
        title: 'AlÃ­ce',
        is_still_participant: true,
        thread_path: 'inbox/alice_1234567890',
        magic_words: [],
    });
    thread('bob_987654321', {
        participants: [{ name: 'Bob' }, { name: 'Me' }],
        messages: [{ sender_name: 'Bob', timestamp_ms: 1760000300000, share: { link: 'https://www.instagram.com/reel/ZZZ999zzz/' } }],
        title: 'Bob',
        is_still_participant: true,
        thread_path: 'inbox/bob_987654321',
        magic_words: [],
    });
    return root;
}

describe('readDmExport', () => {
    test('imports only authorised conversations, oldest first, with sender, time, real author and caption', () => {
        const { items, threads } = readDmExport(writeExport(), ['alice_1234567890']);
        assert.deepEqual(items, [
            {
                shortcode: 'DePb6WLuVae',
                url: 'https://www.instagram.com/reel/DePb6WLuVae/',
                conversation: 'Alíce',
                shared_by: 'Alíce',
                shared_at: '2025-10-09T08:53:20.000Z',
                author: 'instagram',
                caption: 'café vibes',
            },
            {
                shortcode: 'Cx_yz-12AB',
                url: 'https://www.instagram.com/p/Cx_yz-12AB/',
                conversation: 'Alíce',
                shared_by: 'Me',
                shared_at: '2025-10-09T08:55:00.000Z',
                author: undefined,
                caption: undefined,
            },
        ]);
        assert.deepEqual(
            threads.map(t => [t.folder, t.title, t.authorized, t.links]),
            [
                ['alice_1234567890', 'Alíce', true, 2],
                ['bob_987654321', 'Bob', false, 1],
            ]
        );
    });

    test('matches authorised conversations by title as well, ignoring case', () => {
        assert.deepEqual(readDmExport(writeExport(), ['BOB']).items.map(item => item.shortcode), ['ZZZ999zzz']);
    });

    test('imports nothing when no conversation is authorised, but still lists them', () => {
        const { items, threads } = readDmExport(writeExport(), []);
        assert.equal(items.length, 0);
        assert.equal(threads.length, 2);
    });
});

describe('readInput', () => {
    test('reads links from a plain text file', () => {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ig-list-')), 'reels.txt');
        fs.writeFileSync(file, 'https://www.instagram.com/reel/AAA111/\n\nhttps://www.instagram.com/p/BBB222/?igsh=1\n');
        const result = readInput(file, []);
        assert.equal(result.source, 'file:reels.txt');
        assert.deepEqual(result.items.map(item => item.url), ['https://www.instagram.com/reel/AAA111/', 'https://www.instagram.com/p/BBB222/']);
    });

    test('treats an export folder as a DM export', () => {
        const result = readInput(writeExport(), ['bob_987654321']);
        assert.equal(result.source, 'dm-export');
        assert.deepEqual(result.items.map(item => item.shared_by), ['Bob']);
    });

    test('accepts a single URL and rejects anything that is not a reel/post link', () => {
        assert.deepEqual(readInput('https://www.instagram.com/reel/AAA111/?igsh=2', []).items.map(item => item.url), [
            'https://www.instagram.com/reel/AAA111/',
        ]);
        assert.throws(() => readInput('https://www.instagram.com/someone/', []), /Not an Instagram reel\/post link/);
    });
});
