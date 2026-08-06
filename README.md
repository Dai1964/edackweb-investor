# EdackWeb — Investor Landing Page

A single-file investor pitch page for EdackWeb: a complete digital business system for local trades businesses (website + job management + digital contracts), sold territory-by-territory to investors and local licensees.

This is a separate site from the consumer-facing [EdackWeb landing page](https://github.com/Dai1964/edackweb) — same brand, different audience and message.

## Stack

- Single `index.html` — all CSS and JS inline, no build step
- Inter (Google Fonts) is the only external dependency, loaded async so it never blocks first paint
- A ~12-line Express server (`server.js`) just serves that one file on every route — there's no backend logic

## Running locally

```bash
npm install
npm start
```

Visit `http://localhost:3000`.

## Deployment

Deployed as its own Railway project, `edackweb-investor`, entirely separate from the other EdackWeb/LOCIFY Build deployments.
