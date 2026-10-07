# Persistent storage

Manual lyrics and manually selected covers use PostgreSQL when `DATABASE_URL` is set.
The server creates the `manual_lyrics` table automatically on its first database request.

## Render setup

1. Create a Render PostgreSQL database in the same workspace and region as this web service.
2. On the database's **Connect** page, copy its **Internal Database URL**.
3. Open the web service's **Environment** page and set `DATABASE_URL` to that URL.
4. Save and deploy. The service will use PostgreSQL for all new manual lyric and cover edits.

Use the external database URL only from a computer outside Render, such as local development.
