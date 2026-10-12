import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { Shared } from './ingest';

export type ReelStatus = 'queued' | 'proposed' | 'approved' | 'submitted' | 'skipped' | 'unavailable' | 'failed';

export interface ReelRow {
    shortcode: string;
    url: string;
    source: string;
    conversation: string | null;
    shared_by: string | null;
    shared_at: string | null;
    author: string | null;
    caption: string | null;
    status: ReelStatus;
    proposed_comment: string | null;
    final_comment: string | null;
    submission: string | null;
    error: string | null;
    queued_at: string;
    processed_at: string | null;
    decided_at: string | null;
    submitted_at: string | null;
}

// Lifecycle: queued -> proposed (opened + drafted) -> approved | skipped -> submitted.
// unavailable / failed are dead ends; re-adding a failed link queues it again.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS reels (
    shortcode        TEXT PRIMARY KEY,   -- one row per reel/post, ever: the idempotency key
    url              TEXT NOT NULL,
    source           TEXT NOT NULL,      -- manual | file:<name> | dm-export | dm-thread
    conversation     TEXT,               -- DM thread the link came from
    shared_by        TEXT,               -- who sent it (not necessarily the author)
    shared_at        TEXT,
    author           TEXT,               -- the reel's actual author
    caption          TEXT,
    status           TEXT NOT NULL DEFAULT 'queued'
                     CHECK (status IN ('queued', 'proposed', 'approved', 'submitted', 'skipped', 'unavailable', 'failed')),
    proposed_comment TEXT,               -- what the AI drafted
    final_comment    TEXT,               -- what you approved (possibly edited)
    submission       TEXT,               -- outcome, e.g. "posted manually (confirmed)"; "posting" while auto posts
    error            TEXT,               -- "<CATEGORY>: detail" of the last failure
    queued_at        TEXT NOT NULL,
    processed_at     TEXT,               -- opened + drafted; counts toward DAILY_LIMIT
    decided_at       TEXT,
    submitted_at     TEXT
)`;

type Editable = Omit<ReelRow, 'shortcode' | 'queued_at'>;

const EDITABLE = new Set<string>([
    'url', 'source', 'conversation', 'shared_by', 'shared_at', 'author', 'caption', 'status',
    'proposed_comment', 'final_comment', 'submission', 'error', 'processed_at', 'decided_at', 'submitted_at',
]);

export class ReelStore {
    private readonly db: DatabaseSync;

    constructor(file: string) {
        if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(file);
        if (file !== ':memory:') fs.chmodSync(file, 0o600);
        this.db.exec(SCHEMA);
    }

    add(item: Shared, source: string): 'added' | 'requeued' | 'duplicate' {
        const existing = this.db.prepare('SELECT status FROM reels WHERE shortcode = ?').get(item.shortcode);
        if (existing?.status === 'failed') {
            this.update(item.shortcode, { status: 'queued', error: null });
            return 'requeued';
        }
        if (existing) return 'duplicate';
        this.db
            .prepare(
                `INSERT INTO reels (shortcode, url, source, conversation, shared_by, shared_at, author, caption, queued_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                item.shortcode,
                item.url,
                source,
                item.conversation ?? null,
                item.shared_by ?? null,
                item.shared_at ?? null,
                item.author ?? null,
                item.caption ?? null,
                new Date().toISOString()
            );
        return 'added';
    }

    next(status: ReelStatus): ReelRow | undefined {
        return this.db.prepare('SELECT * FROM reels WHERE status = ? ORDER BY rowid LIMIT 1').get(status) as unknown as ReelRow | undefined;
    }

    list(status: ReelStatus): ReelRow[] {
        return this.db.prepare('SELECT * FROM reels WHERE status = ? ORDER BY rowid').all(status) as unknown as ReelRow[];
    }

    update(shortcode: string, fields: Partial<Editable>): void {
        const keys = Object.keys(fields).filter(key => EDITABLE.has(key));
        if (keys.length === 0) return;
        const values = keys.map(key => ((fields as Record<string, SQLInputValue | undefined>)[key] ?? null));
        this.db.prepare(`UPDATE reels SET ${keys.map(key => `${key} = ?`).join(', ')} WHERE shortcode = ?`).run(...values, shortcode);
    }

    processedSince(isoTime: string): number {
        return Number(this.db.prepare('SELECT COUNT(*) AS n FROM reels WHERE processed_at >= ?').get(isoTime)?.n ?? 0);
    }

    lastSubmittedAt(): string | undefined {
        const last = this.db.prepare('SELECT MAX(submitted_at) AS t FROM reels').get()?.t;
        return last == null ? undefined : String(last);
    }

    recentComments(limit: number): string[] {
        return this.db
            .prepare('SELECT final_comment FROM reels WHERE final_comment IS NOT NULL ORDER BY decided_at DESC LIMIT ?')
            .all(limit)
            .map(row => String(row.final_comment));
    }

    counts(): { status: string; n: number }[] {
        return this.db.prepare('SELECT status, COUNT(*) AS n FROM reels GROUP BY status ORDER BY n DESC').all() as unknown as { status: string; n: number }[];
    }

    recent(limit: number): ReelRow[] {
        return this.db
            .prepare('SELECT * FROM reels ORDER BY COALESCE(submitted_at, decided_at, processed_at, queued_at) DESC LIMIT ?')
            .all(limit) as unknown as ReelRow[];
    }
}
