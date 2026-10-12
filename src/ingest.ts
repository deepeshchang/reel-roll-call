import * as fs from 'fs';
import * as path from 'path';
import { BotError } from './logger';

export interface ReelRef {
    /** Stable media id; the same for /p/<code>/ and /reel/<code>/ links, so it is the idempotency key. */
    shortcode: string;
    /** Canonical link: https://www.instagram.com/reel/<code>/ or https://www.instagram.com/p/<code>/ */
    url: string;
}

export interface Shared extends ReelRef {
    conversation?: string;
    shared_by?: string;
    shared_at?: string;
    /** The reel's actual author when the source says so - not necessarily whoever shared it. */
    author?: string;
    caption?: string;
}

const HOSTS = /^(www\.|m\.)?(instagram\.com|instagr\.am)$/i;
// /p/<code>, /reel/<code>, /reels/<code>, /tv/<code>, optionally after /<username>/ (newer link format).
const MEDIA_PATH = /^\/(?:[A-Za-z0-9._]{1,30}\/)?(p|tv|reels?)\/([A-Za-z0-9_-]+)(?:\/|$)/;
const LINK_IN_TEXT = /(?<![\w./-])(?:https?:\/\/)?(?:www\.|m\.)?(?:instagram\.com|instagr\.am)\/[^\s"'<>()[\]]+/gi;

export function canonicalize(raw: string): ReelRef | null {
    const text = raw.trim();
    let url: URL;
    try {
        url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
        return null;
    }
    // ponytail: /share/ short links need a redirect to resolve; they are rejected with a clear message instead.
    if (!HOSTS.test(url.hostname) || url.pathname.startsWith('/share/')) return null;
    const match = MEDIA_PATH.exec(url.pathname);
    if (!match) return null;
    const kind = match[1].startsWith('reel') ? 'reel' : 'p';
    return { shortcode: match[2], url: `https://www.instagram.com/${kind}/${match[2]}/` };
}

export function extractRefs(text: string): ReelRef[] {
    const found = new Map<string, ReelRef>();
    for (const [link] of text.matchAll(LINK_IN_TEXT)) {
        const ref = canonicalize(link);
        if (ref && !found.has(ref.shortcode)) found.set(ref.shortcode, ref);
    }
    return [...found.values()];
}

export interface ExportThread {
    folder: string;
    title: string;
    authorized: boolean;
    links: number;
}

/** Instagram exports store UTF-8 bytes as \u00XX code units; re-decode them. */
function fixText(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    return /[^\u0000-ÿ]/.test(value) ? value : Buffer.from(value, 'latin1').toString('utf8');
}

/**
 * Reads reel/post links from Instagram's own "Download your information" export (JSON format):
 * .../messages/inbox/<thread>/message_N.json. Only conversations listed in `authorized` (folder name
 * or title, any case) are imported; every conversation is still listed so the user can choose.
 */
export function readDmExport(root: string, authorized: string[]): { items: Shared[]; threads: ExportThread[] } {
    const allowed = new Set(authorized.map(name => name.toLowerCase()));
    const files = fs.statSync(root).isDirectory()
        ? fs
              .readdirSync(root, { recursive: true, encoding: 'utf8' })
              .filter(file => /(^|[\\/])message_\d+\.json$/.test(file))
              .map(file => path.join(root, file))
        : [root];

    const threads = new Map<string, ExportThread>();
    const items: Shared[] = [];
    for (const file of files.sort()) {
        const folder = path.basename(path.dirname(file));
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const title = fixText(data.title) ?? folder;
        const thread = threads.get(folder) ?? {
            folder,
            title,
            authorized: allowed.has(folder.toLowerCase()) || allowed.has(title.toLowerCase()),
            links: 0,
        };
        threads.set(folder, thread);

        for (const message of Array.isArray(data.messages) ? data.messages : []) {
            const share = message.share;
            const shared = typeof share?.link === 'string' ? canonicalize(share.link) : null;
            const refs = [
                ...(shared ? [{ ref: shared, share }] : []),
                ...extractRefs(String(message.content ?? ''))
                    .filter(ref => ref.shortcode !== shared?.shortcode)
                    .map(ref => ({ ref, share: undefined })),
            ];
            thread.links += refs.length;
            if (!thread.authorized) continue;
            for (const { ref, share: fromShare } of refs) {
                items.push({
                    ...ref,
                    conversation: title,
                    shared_by: fixText(message.sender_name),
                    shared_at: typeof message.timestamp_ms === 'number' ? new Date(message.timestamp_ms).toISOString() : undefined,
                    author: fromShare ? fixText(fromShare.original_content_owner) : undefined,
                    caption: fromShare ? fixText(fromShare.share_text) : undefined,
                });
            }
        }
    }
    items.sort((a, b) => (a.shared_at ?? '').localeCompare(b.shared_at ?? ''));
    return { items, threads: [...threads.values()] };
}

export interface InputResult {
    source: string;
    items: Shared[];
    threads?: ExportThread[];
}

/** One command-line argument: a reel/post URL, a text file of links, or an export folder / message_N.json. */
export function readInput(input: string, authorizedThreads: string[]): InputResult {
    if (fs.existsSync(input)) {
        if (fs.statSync(input).isDirectory() || /message_\d+\.json$/.test(input)) {
            return { source: 'dm-export', ...readDmExport(input, authorizedThreads) };
        }
        return { source: `file:${path.basename(input)}`, items: extractRefs(fs.readFileSync(input, 'utf8')) };
    }
    const ref = canonicalize(input);
    if (!ref) {
        throw new BotError('INPUT', `Not an Instagram reel/post link, chat link (https://www.instagram.com/direct/t/<id>/), file or export folder: ${input}`);
    }
    return { source: 'manual', items: [ref] };
}
