# Persistent storage

Manual lyrics and manually selected covers use PostgreSQL when `DATABASE_URL` is set.
The server creates the `manual_lyrics` table automatically on its first database request.
Music search uses YouTube Data API v3 and requires `YOUTUBE_API_KEY`.

## Render setup

1. Create a Render PostgreSQL database in the same workspace and region as this web service.
2. On the database's **Connect** page, copy its **Internal Database URL**.
3. Open the web service's **Environment** page and set `DATABASE_URL` to that URL.
4. Save and deploy. The service will use PostgreSQL for all new manual lyric and cover edits.

Use the external database URL only from a computer outside Render, such as local development.

## YouTube Data API

1. Create a Google Cloud project and enable YouTube Data API v3.
2. Create an API key restricted to YouTube Data API v3.
3. Set it as `YOUTUBE_API_KEY` in the Render web service environment.

The app uses the official API for videos, artist channels, and YouTube playlists. Search suggestions are local-only to conserve API quota.
