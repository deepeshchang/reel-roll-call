# Instagram Reel Commenter

Comments on Instagram reels that people share with you, in one of two ways:

- **Auto** (`npm run auto`): the bot comments on every queued reel by itself with one of your short
  phrases ("Nice content 😊", "Cool content <3"), waiting a few minutes between comments, with a daily cap.
- **Review** (`npm run review`): the bot drafts a comment for each reel with Google Gemini, you approve
  it, and you post it yourself.

Built on Playwright, using your own logged-in browser session.

## How it works

1. **Queue reels** (`npm run add`). Give it a chat link (`https://www.instagram.com/direct/t/<id>/`, for
   example your group chat) and it scrolls through the whole chat and queues every reel and post shared
   there. It also takes reel/post links, a text file of links, or the DM export Instagram gives you.
2. **Comment.**
   - `npm run auto`: opens each queued reel, types one of `COMMENT_PHRASES` (random, never the same one
     twice in a row) and clicks Post. Comments go out at least `COMMENT_GAP_SECONDS` apart, even across
     runs, at most `DAILY_LIMIT` per day, and at most `AUTHOR_DAILY_LIMIT` per day on the same account's
     posts (the rest of that account's reels wait for a later day).
   - `npm run review`: shows each reel with an AI draft. You approve, edit, regenerate or skip it, then
     post it yourself from your browser.

Everything is recorded in a local SQLite database: URL, chat, author, comment, status, result and
timestamps. A reel is never commented on twice. The bot marks a reel as "posting" before it clicks Post,
so if a run is cut off mid-post, that reel is not retried.

## Risks and limits (read this)

- **Auto mode is against Instagram's Terms of Use.** Instagram has no API for commenting on other
  people's reels, so auto mode drives your logged-in browser. The same few phrases on many reels look
  like spam to Instagram. Expect possible comment blocks ("Try again later"), hidden comments, or account
  restrictions. Keep `DAILY_LIMIT` and `AUTHOR_DAILY_LIMIT` low and `COMMENT_GAP_SECONDS` high. Many
  comments on one account's posts in a short time look the most like spam.
- **The bot backs off rather than fighting Instagram.** At the first "Try again later", refused comment,
  security check or unrecognised page, it stops. It never solves CAPTCHAs or 2FA, never spoofs a browser
  fingerprint, and never likes, follows or messages anyone.
- **Reading a chat by link** opens it in the logged-in browser, so its messages are marked as seen, just
  as if you had opened it. Instagram changes its chat page often. If `add` finds no links in a chat that
  has shared reels, the page has changed (a screenshot is saved to `data/logs/chat_no_links.png`).
  Encrypted chats may only show recent history on the web.
- **Use the chat's own address, not an invite link.** Open the group in a browser and copy the
  `instagram.com/direct/t/...` URL. Invite links are refused because opening one can add you to a group.

## Setup (macOS)

1. Install Node.js 22.13 or newer (`brew install node`). Node 26 was used to build this; it provides the
   built-in `node:sqlite`.
2. Install dependencies and the Chromium build Playwright uses:
   ```bash
   npm install
   npx playwright install chromium
   ```
3. Create your settings file (gitignored) and fill it in:
   ```bash
   cp .env.example .env
   chmod 600 .env
   open -e .env
   ```
4. Log in once in a visible browser. Complete any two-factor or security step yourself. The session is
   saved to `data/cookies/` (owner-only) and reused by later runs:
   ```bash
   npm run login
   ```

## Settings (`.env`)

| Variable | Required | Meaning |
|---|---|---|
| `IG_USERNAME` | yes | Your Instagram username. |
| `IG_PASSWORD` | no | Lets the bot submit the login form once. Leave empty to type it yourself in `npm run login`. |
| `DRY_RUN` | no | `true` by default. Only the exact value `false` posts anything. |
| `COMMENT_PHRASES` | no | Auto-mode comments, separated by `\|`. Default: `Nice content 😊\|Nice content 🙌\|Nice content 🔥\|Cool content <3`. |
| `COMMENT_GAP_SECONDS` | no | Minimum time between two posted comments, also across runs (default 180). |
| `DAILY_LIMIT` | no | Reels opened per day, so also the most comments per day (default 20). |
| `AUTHOR_DAILY_LIMIT` | no | Most auto comments per day on posts by the same account (default 2). |
| `ACTION_DELAY_SECONDS` | no | Minimum gap between Instagram page loads (default 30). |
| `HEADLESS` | no | `false` shows the browser while it works (default `true`). |
| `GEMINI_API_KEY` | no | Google AI Studio key for review-mode drafts. Without it you write every comment. |
| `GEMINI_MODEL` | no | Defaults to `gemini-flash-lite-latest`. |
| `AI_PROMPT_HINT` | no | Extra guidance for the AI's comment style. |
| `AUTHORIZED_THREADS` | no | Comma-separated chats allowed for DM-export import. |

## Usage

```bash
# 1. Queue every reel/post shared in your group chat
npm run add -- https://www.instagram.com/direct/t/<chat-id>/

# 2. Rehearse: opens each reel, types the comment and clears it again. Nothing is posted or recorded.
npm run auto -- --dry-run

# 3. Go live: posts by itself, 3 minutes apart, up to 20 a day
DRY_RUN=false npm run auto

# Run it again (or daily) to continue; re-adding the chat link queues only new reels (and retries failed ones)
npm run add -- https://www.instagram.com/direct/t/<chat-id>/ && DRY_RUN=false npm run auto

# What happened so far
npm run status
```

Other ways to queue reels:

```bash
npm run add -- https://www.instagram.com/reel/XXXXXXXXXXX/ --from "Alice"
npm run add -- ~/Desktop/reels.txt                          # any text containing links
npm run add -- ~/Downloads/instagram-yourname-2026-10-12/   # unzipped data export (AUTHORIZED_THREADS)
```

Review mode, with approval and manual posting:

```bash
npm run review -- --dry-run      # approvals are recorded, nothing is opened for posting
DRY_RUN=false npm run review     # approved comments are handed to you to post
```

Auto mode also posts comments you approved in a review that were never posted. It comments on those
first, using your approved text.

**Stopping:** press Ctrl+C to finish the current step and exit; press it again to exit immediately. The
next run picks up where this one stopped.

## Troubleshooting

- **`[SESSION_EXPIRED]`, `[AUTH_REQUIRED]`, `[TWO_FACTOR]`, `[CHECKPOINT]`:** run `npm run login` and finish
  the step in the browser window.
- **`[RATE_LIMITED]`:** Instagram blocked an action. Wait several hours (a day is safer), then lower
  `DAILY_LIMIT` or raise `COMMENT_GAP_SECONDS`. The blocked comment is posted on the next run.
- **`[COMMENT_FAILED]`:** Instagram refused a comment, or the bot clicked Post but couldn't see the comment
  appear. Check that reel in your browser. Unconfirmed comments are never retried.
- **`[UNKNOWN_PAGE]`:** a page didn't match anything known. A screenshot is saved in `data/logs/`.
- Logs: human-readable on screen, structured JSON lines in `data/logs/bot.jsonl`. Passwords and API keys
  are redacted.

## Development

```bash
npm test           # offline tests: real headless Chromium against local copies of Instagram's pages
npm run typecheck
```

## Disclaimer

Use this with your own account and at your own risk. Automated commenting breaks Instagram's Terms of
Use and can get your account restricted or disabled.
