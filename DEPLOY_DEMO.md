# Public demo deployment

This project can be shown in two modes:

1. Public portfolio demo: `/demo`
   - Uses in-app seeded data.
   - Does not require Shopify login.
   - Does not read or write real store data.
   - Good for portfolio review, interviews, and stakeholder feedback.

2. Shopify embedded app: `/app`
   - Runs inside Shopify Admin.
   - Requires Shopify OAuth.
   - Real order data requires Shopify protected customer data approval.

## Recommended public demo URL

After deployment, share:

```text
https://YOUR_DOMAIN/demo
```

The route redirects to:

```text
/app?demo=seeded
```

## Environment variables

Do not commit secrets to Git.

Set these on the hosting platform:

```text
SHOPIFY_API_KEY=public_client_id
SHOPIFY_API_SECRET=server_only_secret
SHOPIFY_APP_URL=https://YOUR_DOMAIN
SCOPES=read_products
DATABASE_URL=file:dev.sqlite
```

If a real OpenAI explanation endpoint is added later, keep the model key server-side:

```text
AI_API_KEY=server_only_secret
AI_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-chat
```

For OpenAI, use an OpenAI base URL and model instead:

```text
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL=your_model_name
```

Never expose `SHOPIFY_API_SECRET`, `AI_API_KEY`, `DEEPSEEK_API_KEY`, or
`OPENAI_API_KEY` in browser code.

## CloudBase demo persistence

The public static demo persists rule settings and automatic inspection history
through the server-side CloudBase HTTP function. The browser keeps a generated
`demoId`, then calls the server endpoint to read and write normalized documents.

The demo uses the generated `demoId` as a temporary `shopId`, then writes into
these collections:

- `shopify_ai_shops`
- `shopify_ai_rules`
- `shopify_ai_inspections`
- `shopify_ai_alerts`
- `shopify_ai_reports`

This keeps the model key and database access server-side while still allowing
the public link to behave like a real product demo. If this becomes a real
Shopify app, replace the generated `demoId` with the authenticated Shopify shop
domain or shop ID.

## Build commands

```bash
npm install
npm run setup
npm run build
npm run start
```

For a portfolio demo, the seeded demo mode is enough. For real stores, complete
Shopify OAuth, app URL configuration, and protected customer data requirements.
