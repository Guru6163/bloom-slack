# Bloom Slack — local setup and testing

This guide walks you from an empty machine to a running **Next.js** app in `bloom-slack-nextjs/`, with **Supabase** Postgres and (optionally) **Slack** hitting your machine via an HTTPS tunnel.

---

## 1. Prerequisites

| Requirement | Notes |
|-------------|--------|
| **Node.js 20+** | Matches `package.json` engines expectations for Next 16. |
| **npm** | Used by this repo (`package-lock.json`). |
| **Supabase project** | Hosted project at [supabase.com](https://supabase.com), or local stack via [Supabase CLI](https://supabase.com/docs/guides/cli). |
| **Slack app** | Create at [api.slack.com/apps](https://api.slack.com/apps) when you want real Slack traffic (mentions, slash commands, buttons). |
| **OpenAI API key** | Required for the `@Bloom` conversational agent (`gpt-4o`). |
| **Bloom API access** | Required after install, when you complete brand/API key setup in the Slack setup UI. |
| **HTTPS tunnel (optional)** | e.g. [ngrok](https://ngrok.com/) or [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/). Slack must call **HTTPS** URLs; plain `http://localhost:3000` is not reachable from Slack’s servers. |

---

## 2. Repository layout

- **`bloom-slack-nextjs/`** — Next.js app (run this locally).
- **`supabase/migrations/`** — Postgres schema; apply to your Supabase database in numeric order.

---

## 3. Install Node dependencies

```bash
cd bloom-slack-nextjs
npm install
```

---

## 4. Database (Supabase Postgres)

Create a Supabase project (or start a local Supabase stack). Then apply every migration **in order**:

1. `supabase/migrations/001_schema.sql`
2. `supabase/migrations/002_engagement_and_templates.sql`
3. `supabase/migrations/003_agent_and_setup.sql`
4. `supabase/migrations/004_generation_jobs_thread_ts.sql`

**Option A — Supabase Dashboard (simplest)**  
Project → **SQL Editor** → New query → paste each file’s contents → Run. Repeat for all four files in order.

**Option B — Supabase CLI**  
From the repository root, with the CLI installed and the project linked (`supabase link`), use your normal workflow to push migrations (for example `supabase db push`), as long as your migration folder matches what the CLI expects for your project.

After migrations, you should have tables such as `workspace_configs`, `generation_jobs`, and agent-related tables used by the Next.js routes.

---

## 5. Environment variables

From `bloom-slack-nextjs/`:

```bash
cp .env.example .env.local
```

Edit **`.env.local`** (never commit real secrets). Variables used by the app:

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Supabase project URL (Settings → API). |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (server-only). Used for DB access and as the bearer token for internal job routes. |
| `SLACK_CLIENT_ID` | Slack app → **Basic Information** → App Credentials. |
| `SLACK_CLIENT_SECRET` | Same. |
| `SLACK_SIGNING_SECRET` | Same; verifies `POST /api/slack/events`. |
| `SLACK_REDIRECT_URI` | Optional. If unset, defaults to `{NEXT_PUBLIC_APP_URL}/api/slack/oauth` (must **exactly** match a URL in Slack’s **OAuth Redirect URLs**). |
| `NEXT_PUBLIC_APP_URL` | Public base URL, **no trailing slash**. For Slack-facing flows, use your **tunnel HTTPS URL** (see section 7), not `http://localhost:3000` alone. |
| `OPENAI_API_KEY` | Powers the `@Bloom` agent. |

Restart `npm run dev` after any change to `.env.local`.

---

## 6. Run the Next.js dev server

```bash
cd bloom-slack-nextjs
npm run dev
```

Default: **Webpack** (`next dev --webpack`). For Turbopack:

```bash
npm run dev:turbo
```

The app listens on **http://localhost:3000** by default.

---

## 7. Expose HTTPS for Slack (required for real Slack → your laptop)

Slack sends Events, slash commands, and interactivity to URLs you configure. Those URLs must be **HTTPS** and reachable from the internet.

1. Start the dev server (section 6).
2. Start a tunnel that forwards to `localhost:3000` and gives you a stable HTTPS origin (for example `https://abc123.ngrok-free.app`).
3. Set in **`.env.local`**:

   ```bash
   NEXT_PUBLIC_APP_URL=https://your-tunnel-host.example
   ```

   If ngrok (or similar) changes the hostname when it restarts, update **`NEXT_PUBLIC_APP_URL`**, **`SLACK_REDIRECT_URI`** (if you set it), and every Slack **Request URL** / **Redirect URL** to match.

4. Restart `npm run dev`.

---

## 8. Configure the Slack app

Do this after **`NEXT_PUBLIC_APP_URL`** is set to the URL Slack will call (tunnel or deployed host).

### 8.1 Credentials

**Settings → Basic Information → App Credentials** — copy into `.env.local`:

- Client ID → `SLACK_CLIENT_ID`
- Client Secret → `SLACK_CLIENT_SECRET`
- Signing Secret → `SLACK_SIGNING_SECRET`

### 8.2 OAuth and permissions

**OAuth & Permissions**:

1. **Redirect URLs** — add exactly (replace with your public base, no trailing slash):

   ```text
   https://YOUR_HOST/api/slack/oauth
   ```

2. **Bot Token Scopes** — add (must match `bloom-slack-nextjs/app/api/slack/install/route.ts`):

   - `app_mentions:read`
   - `channels:history`
   - `chat:write`
   - `commands`
   - `groups:history`
   - `im:write`

### 8.3 Event subscriptions

**Event Subscriptions** → enable events.

- **Request URL**: `https://YOUR_HOST/api/slack/events`  
  Slack sends a URL verification challenge; the app answers with the `challenge` value.

**Subscribe to bot events** (minimum set used by the app):

- `app_mention`
- `message.channels`
- Add `message.groups` if you use private channels.

### 8.4 Slash command

**Slash Commands** → create `/bloom-gen`:

- **Request URL**: `https://YOUR_HOST/api/slack/events`

### 8.5 Interactivity

**Interactivity & Shortcuts** → enable interactivity.

- **Request URL**: `https://YOUR_HOST/api/slack/events`

### 8.6 Install to workspace

In a browser (while dev server + tunnel use the same `NEXT_PUBLIC_APP_URL`):

```text
https://YOUR_HOST/api/slack/install
```

Complete OAuth. You should land on a success path; **`workspace_configs`** should gain a row for your Slack team.

### 8.7 Bloom setup

Use the **Set up your brand** / setup link from the install success flow to open the setup page and save your **Bloom API key** (and brand selection as the UI requires). Secrets are stored in Supabase (`workspace_configs`), not only in Slack.

---

## 9. Testing (without relying on Slack)

These checks validate tooling, env loading, and build output. They do **not** require Slack to be configured.

### 9.1 Lint

```bash
cd bloom-slack-nextjs
npm run lint
```

### 9.2 Production build

```bash
cd bloom-slack-nextjs
npm run build
npm start
```

`npm start` serves the production build (default port 3000 unless overridden). Use this to catch type and Next.js build issues before deploy.

### 9.3 HTTP smoke test (events route, no Slack signature)

The `GET` handler for `/api/slack/events` supports a simple health-style query (see `bloom-slack-nextjs/app/api/slack/events/route.ts`):

```bash
curl -sS "http://localhost:3000/api/slack/events?test=1"
```

Expected: JSON including `"ok": true` (and a short message). If you use a tunnel, replace the host with your tunnel URL the same way.

**Note:** `POST /api/slack/events` always runs **Slack request signing** verification first. Testing a real POST body from `curl` requires implementing Slack’s signing algorithm or using Slack’s “Send test request” from the app settings (which includes valid signatures). For quick local checks, prefer the `GET ?test=1` probe above.

### 9.4 OAuth redirect URI hint (debug)

If OAuth fails with a redirect mismatch, open (in the browser):

```text
https://YOUR_HOST/api/slack/oauth
```

(with no `code` query parameter). The response is designed to surface the redirect URI the server is using so you can paste it into Slack’s **Redirect URLs** list.

---

## 10. Testing with Slack (end-to-end)

After sections 7–8:

1. **URL verification** — in Slack app settings, the Events **Request URL** should show **Verified**.
2. **Install** — `/api/slack/install` completes and `workspace_configs` has your `team_id`.
3. **Bloom** — complete setup so `bloom_api_key` / brand fields are populated.
4. In a channel where the bot is present:
   - Mention **`@YourAppName`** to exercise the OpenAI agent path.
   - Run **`/bloom-gen`** for slash-command flows.
   - Use Block Kit buttons on a generation message for interactivity.

Watch the terminal running `npm run dev` for errors and route logs.

---

## 11. Internal API routes (advanced)

Background work calls:

- `POST /api/internal/openai-agent`
- `POST /api/internal/run-generation`

These expect **`Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`** (same value as in `.env.local`), as documented in `bloom-slack-nextjs/lib/internal-auth.ts`. They are normally invoked by the app after Slack events are acknowledged, not by hand. If you script them, never commit or log the service role key.

---

## 12. Troubleshooting

| Symptom | Things to check |
|---------|------------------|
| Slack URL verification fails | Tunnel running; `NEXT_PUBLIC_APP_URL` matches the URL Slack calls; no typo in path `/api/slack/events`. |
| OAuth redirect mismatch | Slack **Redirect URLs** must match `getSlackOAuthRedirectUri()` output (section 9.4). |
| `401` on `POST /api/slack/events` | `SLACK_SIGNING_SECRET` matches the app; body must be raw (signing is over the raw body). |
| Agent or generation errors | `OPENAI_API_KEY` set; Bloom key and brand saved in setup; Supabase URL and service role correct. |
| Internal jobs never run | `NEXT_PUBLIC_APP_URL` must be a URL your **server** can call (tunnel or public host); background `fetch` uses this base. |

---

## 13. Related docs in this repo

- **`bloom-slack-nextjs/README.md`** — Slack URL cheat sheet and route summary.
- **`BLOOM_SLACK_AI_AGENT_GUIDE.md`** — Architecture and product behavior for deeper debugging.
