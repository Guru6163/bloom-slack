# Bloom Slack (Next.js)

Next.js implementation of the **Bloom** Slack app: OAuth install, Events API (`@Bloom`, thread replies), slash command `/bloom-gen`, interactive buttons, Bloom image generation, and OpenAI-powered agent replies. Uses the same **Supabase Postgres** schema as the original Deno Edge Functions in this repo’s `supabase/` folder.

---

## Set up locally

### 1. Prerequisites

- **Node.js 20+**
- A **Supabase** project (Postgres)
- A **Slack app** you will configure at [api.slack.com/apps](https://api.slack.com/apps) (steps below)
- **Bloom** API access and an **OpenAI** API key for the conversational agent

### 2. Install dependencies

From the repository root:

```bash
cd bloom-slack-nextjs
npm install
```

### 3. Database (Supabase)

Create a Supabase project, then apply the SQL migrations in order from [`../supabase/migrations`](../supabase/migrations) (`001_schema.sql` through `004_…`). That creates tables such as `workspace_configs`, `generation_jobs`, and `agent_conversations`.

If you use the [Supabase CLI](https://supabase.com/docs/guides/cli) linked to this repo, you can run migrations from the repo root instead of pasting files manually.

### 4. Environment variables

Copy the example file and edit it:

```bash
cp .env.example .env.local
```

Fill in at least the variables below (see `.env.example` for comments). Never commit real secrets; `.env` / `.env.local` should stay local.

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (server only; never expose to the browser) |
| `SLACK_CLIENT_ID` | From Slack app → **Basic Information** → *App Credentials* |
| `SLACK_CLIENT_SECRET` | Same |
| `SLACK_SIGNING_SECRET` | Same; used to verify requests to `/api/slack/events` |
| `SLACK_REDIRECT_URI` | Optional; if unset, defaults to `{NEXT_PUBLIC_APP_URL}/api/slack/oauth` |
| `NEXT_PUBLIC_APP_URL` | Public **https** base URL with **no trailing slash** (see step 5) |
| `OPENAI_API_KEY` | Powers the `@Bloom` agent (`gpt-4o`) |

The app is deployed on Vercel at **https://bloom-slack.vercel.app**. Use that URL (no trailing slash) as `NEXT_PUBLIC_APP_URL` in the Vercel project environment. The Slack section below uses this host for every request URL.

Slack’s servers cannot reach `http://localhost:3000`. If you run `npm run dev` only on your laptop and still want Slack to hit your machine, use an HTTPS tunnel (for example ngrok), set `NEXT_PUBLIC_APP_URL` to the tunnel URL, and use that URL in Slack instead of the Vercel host.

### 5. Run the app and verify the public URL

**Production (Vercel)** — set in Vercel **Settings → Environment Variables**:

```bash
NEXT_PUBLIC_APP_URL=https://bloom-slack.vercel.app
# Optional, only if you do not want the default:
# SLACK_REDIRECT_URI=https://bloom-slack.vercel.app/api/slack/oauth
```

**Local development** — in one terminal:

```bash
npm run dev
```

- Default dev server uses **Webpack** (`next dev --webpack`). Use `npm run dev:turbo` if you prefer Turbopack.

Point `NEXT_PUBLIC_APP_URL` at **https://bloom-slack.vercel.app** when you are exercising the live deploy, or at your tunnel URL when Slack must reach your local process. Restart `npm run dev` after changing `.env.local`.

Quick health check (optional):

```bash
curl -sS "https://bloom-slack.vercel.app/api/slack/events?test=1"
```

You should see JSON like `{ "ok": true, … }`.

---

## Set up the Slack app (api.slack.com)

Do this **after** `NEXT_PUBLIC_APP_URL` matches your deployment. The URLs below assume production at **https://bloom-slack.vercel.app** (no trailing slash); substitute your own host if you deploy elsewhere.

### 1. Create the app

1. Open [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**.
2. Pick a name and a development workspace.

### 2. Credentials → `.env.local`

Open **Settings** → **Basic Information** → **App Credentials**:

- Copy **Client ID** → `SLACK_CLIENT_ID`
- Copy **Client Secret** → `SLACK_CLIENT_SECRET`
- Copy **Signing Secret** → `SLACK_SIGNING_SECRET`

Restart `npm run dev` if the app was already running.

### 3. OAuth & permissions

Under **OAuth & Permissions**:

1. **Redirect URLs** — add **exactly** (Slack is strict about the match):

   ```text
   https://bloom-slack.vercel.app/api/slack/oauth
   ```

2. **Scopes** → **Bot Token Scopes** — add these (they must match [`app/api/slack/install/route.ts`](app/api/slack/install/route.ts)):

   - `app_mentions:read`
   - `channels:history`
   - `chat:write`
   - `commands`
   - `groups:history`
   - `im:write`

You do **not** need Socket Mode for this app; it uses HTTP endpoints on your server.

### 4. Event Subscriptions

Under **Event Subscriptions**:

1. Turn **Enable Events** **On**.
2. **Request URL**: `https://bloom-slack.vercel.app/api/slack/events`  
   Slack will send a URL verification request; the app responds with the `challenge` automatically.
3. Under **Subscribe to bot events**, add at least:

   - `app_mention`
   - `message.channels`  
   - Add `message.groups` as well if you use private channels.

Save changes.

### 5. Slash command

Under **Slash Commands** → **Create New Command**:

| Field | Value |
|-------|--------|
| Command | `/bloom-gen` |
| Request URL | `https://bloom-slack.vercel.app/api/slack/events` |
| Short description | e.g. `Bloom image generation` |

Save.

### 6. Interactivity

Under **Interactivity & Shortcuts**:

1. Turn **Interactivity** **On**.
2. **Request URL**: `https://bloom-slack.vercel.app/api/slack/events`

Save.

### 7. Install into your workspace (OAuth)

1. Confirm the **Redirect URL** from step 3 is saved.
2. In a browser, open:

   **`https://bloom-slack.vercel.app/api/slack/install`**

3. Approve the install in Slack. You should see a success page; the dev server logs should include something like `[slack-oauth] saved workspace_configs for team_id=…`.

**Redirect URI mismatch:** Open `https://bloom-slack.vercel.app/api/slack/oauth` with **no** query string. The response shows the exact redirect URI this server uses — paste that string into Slack’s **Redirect URLs** if OAuth still fails.

### 8. Bloom setup in Slack

Use the **Set up your brand** link from the success flow (or your setup DM) to enter your Bloom API key on the setup page (`https://bloom-slack.vercel.app/api/slack/setup?token=…`).

---

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

---

## Build

```bash
npm run build
npm start
```

`run-generation` sets a long `maxDuration` for serverless hosts that support it; tune for your host.

---

## Security notes

- **Rotate** any credentials that were pasted into chat, tickets, or screenshots.
- Never commit `.env` or `.env.local` (see `.gitignore`). Use `.env.example` only for placeholders.
- The **Slack bot token** and **Bloom API key** live in `workspace_configs`; protect Supabase access accordingly.

---

## Related

- Original Edge Function sources: [`../supabase/functions`](../supabase/functions)
- Database migrations: [`../supabase/migrations`](../supabase/migrations)
