# Bloom Slack (Next.js)

Next.js implementation of the **Bloom** Slack app: OAuth install, Events API (`@Bloom`, thread replies), slash command `/bloom-gen`, interactive buttons, Bloom image generation, and OpenAI-powered agent replies. Uses the same **Supabase Postgres** schema as the original Deno Edge Functions in this repo’s `supabase/` folder.

## Prerequisites

- **Node.js 20+** (recommended)
- A **Supabase** project with migrations applied from [`../supabase/migrations`](../supabase/migrations) (tables such as `workspace_configs`, `generation_jobs`, `agent_conversations`, etc.)
- A **Slack app** on [api.slack.com/apps](https://api.slack.com/apps)
- **Bloom** API access and an **OpenAI** API key for the conversational agent

## Environment

Copy `.env.example` to `.env` or `.env.local` and fill in values. See `.env.example` for the full list.

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (server only; never expose to the browser) |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | Slack app credentials |
| `SLACK_SIGNING_SECRET` | Verifies Slack requests to `/api/slack/events` |
| `SLACK_REDIRECT_URI` | Optional; defaults to `{NEXT_PUBLIC_APP_URL}/api/slack/oauth` |
| `NEXT_PUBLIC_APP_URL` | Public **https** base URL of this app (no trailing slash). Required for OAuth, setup links, and background jobs when not on `localhost` alone |
| `OPENAI_API_KEY` | Used by `@Bloom` agent (`gpt-4o`) |

Slack cannot call `http://localhost` directly. For local development use **ngrok** (or similar) and set `NEXT_PUBLIC_APP_URL` to your tunnel URL.

## Local development

```bash
npm install
npm run dev
```

- Default dev server uses **Webpack** (`next dev --webpack`) to avoid heavy Turbopack file-watching on some machines.
- Use `npm run dev:turbo` if you prefer Turbopack.

In another terminal (expose port 3000):

```bash
ngrok http 3000
```

Set `NEXT_PUBLIC_APP_URL` (and `SLACK_REDIRECT_URI` if you use it) to the **https** ngrok URL, restart `npm run dev`, then configure Slack (below).

## Slack app configuration

Under **OAuth & Permissions → Redirect URLs**, add **exactly**:

```text
{NEXT_PUBLIC_APP_URL}/api/slack/oauth
```

Example: `https://abc123.ngrok-free.app/api/slack/oauth`

**Bot token scopes** (align with [`app/api/slack/install/route.ts`](app/api/slack/install/route.ts)): `app_mentions:read`, `channels:history`, `chat:write`, `commands`, `groups:history`, `im:write`.

| Slack setting | Request URL |
|---------------|-------------|
| **Event Subscriptions** | `{NEXT_PUBLIC_APP_URL}/api/slack/events` |
| **Slash commands** (`/bloom-gen`) | `{NEXT_PUBLIC_APP_URL}/api/slack/events` |
| **Interactivity** | `{NEXT_PUBLIC_APP_URL}/api/slack/events` |

Subscribe to bot events such as **`app_mention`** and **`message.channels`** (and `message.groups` if you use private channels).

### First install (creates `workspace_configs` row)

1. Confirm redirect URL is saved in Slack (see above).
2. Open in a browser: **`{NEXT_PUBLIC_APP_URL}/api/slack/install`**
3. Complete Slack authorization. You should see a success page; the terminal should log `[slack-oauth] saved workspace_configs for team_id=…`.
4. Use the **Set up your brand** link (or Slack DM) to enter your Bloom API key on the setup page.

**Debug:** Open `{NEXT_PUBLIC_APP_URL}/api/slack/oauth` (no query) to print the exact redirect URI this server uses—paste that into Slack if OAuth reports `redirect_uri` mismatch.

## HTTP routes (summary)

| Path | Role |
|------|------|
| `GET /api/slack/install` | Redirects to Slack OAuth authorize |
| `GET /api/slack/oauth` | OAuth callback (or plain-text redirect URI hint without `code`) |
| `POST /api/slack/events` | Events API, slash commands, interactivity (verify `SLACK_SIGNING_SECRET`) |
| `GET /api/slack/setup?token=…` | Bloom brand / API key setup UI |
| `POST /api/slack/setup/validate-key`, `…/brands`, `…/save` | Setup form API |
| `POST /api/internal/openai-agent` | Agent + Bloom listing (Bearer: `SUPABASE_SERVICE_ROLE_KEY`) |
| `POST /api/internal/run-generation` | Long-running Bloom generation (same auth) |

Internal routes are invoked by the app after Slack events are acknowledged; keep the service role secret server-side only.

## Build

```bash
npm run build
npm start
```

`run-generation` sets a long `maxDuration` for serverless hosts that support it; tune for your host.

## Security notes

- **Rotate** any credentials that were pasted into chat, tickets, or screenshots.
- Never commit `.env` (see `.gitignore`). Use `.env.example` only for placeholders.
- The **Slack bot token** and **Bloom API key** live in `workspace_configs`; protect Supabase access accordingly.

## Related

- Original Edge Function sources: [`../supabase/functions`](../supabase/functions)
- Database migrations: [`../supabase/migrations`](../supabase/migrations)
