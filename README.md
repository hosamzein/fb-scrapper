# fb-scrapper

Migrates the original n8n workflow into a GitHub Actions scheduled job that:

1. Fetches Facebook page posts from the Graph API.
2. Normalizes media-only posts to `[Media Only Post]`.
3. Upserts rows into an existing Google Sheets tab using `post url` as the unique key.

## Workflow schedule

The GitHub Actions workflow runs on:

- Manual trigger: `workflow_dispatch`
- Cron: `0 */12 * * *`

GitHub cron uses UTC. This means the current schedule runs at `00:00 UTC` and `12:00 UTC` every day.

## Required GitHub secrets

Add these repository secrets in GitHub:

- `FACEBOOK_PAGE_ID`
- `FACEBOOK_PAGE_ACCESS_TOKEN`
- `GOOGLE_SHEETS_SPREADSHEET_ID`
- `GOOGLE_SHEETS_SHEET_GID`
- `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`

Optional variables already defaulted in code:

- `FACEBOOK_API_VERSION` defaults to `v24.0`
- `GOOGLE_SHEETS_SHEET_NAME` can be used instead of `GOOGLE_SHEETS_SHEET_GID`

## Facebook credential you need to provide

For the Facebook side, I need:

- A valid Page Access Token with permission to read the target page feed.

If you want the page ID to stay configurable instead of hardcoded, also provide:

- The Facebook Page ID

## Google Sheets setup

This GitHub workflow uses a Google service account instead of an interactive OAuth login.

1. Create a Google Cloud service account.
2. Enable the Google Sheets API.
3. Generate a JSON key for the service account.
4. Share the target spreadsheet with the service account email as an editor.
5. Base64-encode the full JSON key and store it in `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`.

For your current spreadsheet:

- `GOOGLE_SHEETS_SPREADSHEET_ID`: `1Z1BkoqOHMjWugdnkmEdz1octG51oDiVb2_zxmIhy_HM`
- `GOOGLE_SHEETS_SHEET_GID`: `2144150873`

The script writes these columns to the existing target tab:

- `post content`
- `post url`
- `publishing timestamp`
- `image in post`

## Local run

Install dependencies and run:

```bash
npm install
npm run sync:facebook-to-sheets
```

Required environment variables are the same as the GitHub secrets listed above.
