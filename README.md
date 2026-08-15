# Playwright Worker

Separate Node.js program for **TradingView Access Manager**.

This folder is **not** installed through WordPress.

## Setup (beginner)

1. Put this `worker` folder somewhere easy (example: `C:\TVAM-worker`).
2. Install [Node.js LTS](https://nodejs.org) if needed.
3. Open a terminal **inside** this folder.
4. Configure environment:

```bash
cp .env.example .env
```

Edit `.env` with:

- `TVAM_API_BASE_URL` — from **TradingView Manager → Settings** (example: `https://yoursite.com/wp-json/tvam/v1`)
- `TVAM_API_KEY` — from the same Settings page

5. Install dependencies:

```bash
npm install
npx playwright install chromium
```

6. Log in to TradingView (publisher account):

```bash
npm run login
```

7. Start the worker and leave it running:

```bash
npm start
```

Full beginner guide: see the main **README.md** delivered with the project / plugin ZIP.
