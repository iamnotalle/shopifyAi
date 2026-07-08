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

## Build commands

```bash
npm install
npm run setup
npm run build
npm run start
```

For a portfolio demo, the seeded demo mode is enough. For real stores, complete
Shopify OAuth, app URL configuration, and protected customer data requirements.
