# EdackWeb — Investor Landing Page

A single-file investor pitch page for EdackWeb: a complete digital business system for local trades businesses (website + job management + digital contracts), sold territory-by-territory to investors and local licensees.

This is a separate site from the consumer-facing [EdackWeb landing page](https://github.com/Dai1964/edackweb) — same brand, different audience and message.

## Stack

- Single `public/index.html` — all CSS and JS inline, no build step. Inter (Google Fonts) is the only external dependency, loaded async so it never blocks first paint.
- Express server (`server.js`) serves `public/` only — not the project root, so `server.js`/`package.json` etc. are never web-accessible
- The contact form POSTs to `/api/enquiry`, which saves the submission to `data/enquiries.json` and sends an email notification via [Resend](https://resend.com) to `edack.david@gmail.com`. A missing/failing Resend call never blocks the submission — the enquiry is already saved to disk before the email is attempted.

## Running locally

```bash
npm install
cp .env.example .env   # optional — RESEND_API_KEY, if you want real email notifications locally
npm start
```

Visit `http://localhost:3000`. Without `RESEND_API_KEY` set, the form still works and still saves to `data/enquiries.json` — email notification is just skipped (logged, not an error).

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | No | Defaults to 3000 |
| `DATA_DIR` | No | Where `enquiries.json` lives. On Railway, points at the mounted volume so submissions survive a redeploy. |
| `RESEND_API_KEY` | No | Enables the email notification. Get one from the [Resend dashboard](https://resend.com). |

## Deployment

Deployed as its own Railway project, `edackweb-investor`, entirely separate from the other EdackWeb/LOCIFY Build deployments.
