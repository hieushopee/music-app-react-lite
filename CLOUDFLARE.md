# Deploy to Cloudflare for free

This project runs as one Cloudflare Worker:

- React files are served as Worker assets.
- `/api/*` runs in `src/worker.ts`.
- Manual lyrics and custom covers are stored in D1.
- `YOUTUBE_API_KEY` is stored as a Cloudflare secret, never in Git.

Cloudflare's free tier is enough for a personal music app. Do not keep the Render service running after the Cloudflare deployment is verified.

## One-time setup

1. Create or sign in to a Cloudflare account at <https://dash.cloudflare.com/>.
2. Open a terminal in this repository and install the project dependencies:

   ```powershell
   npm install
   ```

3. Authenticate Wrangler. It opens a browser window; approve the login there:

   ```powershell
   npx wrangler login
   ```

4. Create the free D1 database:

   ```powershell
   npx wrangler d1 create music-app-db
   ```

   Wrangler prints a JSON configuration block containing a `database_id`. Copy only that UUID.

5. Open `wrangler.jsonc` and replace this placeholder with the UUID from the previous command:

   ```json
   "database_id": "00000000-0000-0000-0000-000000000000"
   ```

6. Store the existing Google Cloud YouTube Data API key as a Cloudflare secret. Paste it only when Wrangler prompts; it will not appear in the terminal history or Git:

   ```powershell
   npx wrangler secret put YOUTUBE_API_KEY
   ```

7. Apply the D1 migration and deploy:

   ```powershell
   npm run deploy
   ```

The final command prints the public `*.workers.dev` URL. Open:

```text
https://YOUR-WORKER.workers.dev/api/health
```

Expected result:

```json
{"ok":true,"source":"cloudflare-worker","database":"connected","configured":true}
```

## Future updates

After changing code:

```powershell
git pull
npm install
npm run deploy
```

`npm run deploy` builds the React app, applies new D1 migrations, and deploys the Worker in that order. D1 data persists across every deployment.

## Local development

Create a local secret file from the example, then enter a development YouTube API key:

```powershell
Copy-Item .dev.vars.example .dev.vars
npm run d1:local
npm run dev
```

Open <http://localhost:5173>. The Vite frontend proxies `/api` to the local Worker at port 8787. Local D1 data is stored under `.wrangler` and is not pushed to Cloudflare.

## Optional custom domain

In Cloudflare Dashboard: **Workers & Pages** -> `music-app-react-lite` -> **Settings** -> **Domains & Routes** -> **Add**. Add a domain already managed by Cloudflare.
