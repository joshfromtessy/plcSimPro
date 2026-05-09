# Cloudflare + Supabase Setup

This app is a Vite static frontend. Supabase values are read through
`import.meta.env`, so Cloudflare must provide them during the build.

## Cloudflare Environment Variables

In Cloudflare:

1. Open `Workers & Pages`.
2. Select the PLC Sim Pro project.
3. Go to `Settings`.
4. Under `Variables and Secrets`, add:

```text
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
```

5. Redeploy the project.

Use the same variables for Preview if you want branch/preview deploys to test
login and cloud saves.

## Supabase Values

In Supabase:

1. Open the project.
2. Go to `Project Settings`.
3. Open `API`.
4. Copy the project URL.
5. Copy the public anon key.

## Do Not Commit Real Values

Do not commit real project values into `wrangler.jsonc` or `.env` files.
The Supabase anon key is intended to be public in browser apps, but keeping
deployment-specific values in Cloudflare avoids accidental stale configs and
keeps previews/production configurable separately.

## Database

Run `supabase-projects.sql` in the Supabase SQL editor before testing
`Cloud Save` and `Cloud Open`.
