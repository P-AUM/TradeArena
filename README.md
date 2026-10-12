# TradeArena

Paper-trading social arena for crypto (and forex wallets). Traders compete with virtual capital; viewers follow traders, watch history, and climb public leaderboards. No real money is at risk.

**Stack:** Next.js (frontend) · Django / DRF (backend) · SQLite locally · live Binance market data

| Service   | URL                         | Port |
|-----------|-----------------------------|------|
| Frontend  | http://localhost:3333       | 3333 |
| Backend   | http://127.0.0.1:7777/api   | 7777 |

---

## Overview

### Roles
- **Trader** — paper wallets (spot / futures / forex), trade terminal, positions, SL/TP, history
- **Viewer** — browse traders, follow, alerts, leaderboards (no trading)

### Features
- Live Binance spot & futures (search, order book, trades, ticker, websockets)
- TradingView chart, market & limit orders, leverage, margin, liquidation price
- Add / trim / close positions; stop-loss & take-profit
- Trade history for any trader
- Leaderboards (PnL, ROI, win rate — daily / weekly / all-time)
- Follow / following
- In-app alerts when followed traders open or close
- Password reset OTP via **Gmail API** (preferred) or Resend fallback

---

## Prerequisites

- **Node.js** 20+ and npm
- **Python** 3.11+ (3.12 / 3.14 OK)
- Git

---

## Clone

```bash
git clone https://github.com/P-AUM/TradeArena.git
cd TradeArena
```

The repo includes `backend/db.sqlite3` (sample / local paper data).  
**Secrets are not in git** — you must create `backend/.env` yourself.

---

## Backend setup

```bash
cd backend
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS / Linux
# source .venv/bin/activate

pip install -r requirements.txt
```

### Environment file

```bash
# Windows
copy .env.example .env

# macOS / Linux
# cp .env.example .env
```

Edit `backend/.env` (minimum for local run):

```env
DJANGO_SECRET_KEY=dev-only-change-me
DJANGO_DEBUG=true
DJANGO_ALLOWED_HOSTS=localhost,127.0.0.1
CORS_ALLOWED_ORIGINS=http://localhost:3333,http://127.0.0.1:3333
DEFAULT_FROM_EMAIL=TradeArena <you@gmail.com>
EMAIL_SHOW_DEV_OTP=false
```

**OTP email (optional but recommended)** — Gmail API:

1. Enable Gmail API in Google Cloud  
2. OAuth consent (External + Testing) + add your sender as a **test user**  
3. Create a **Desktop** OAuth client  
4. Set `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` in `.env`  
5. Run:

```bash
python manage.py gmail_oauth_setup
```

6. Paste `GMAIL_REFRESH_TOKEN` into `.env` and set:

```env
GMAIL_SENDER=TradeArena <your-gmail@gmail.com>
DEFAULT_FROM_EMAIL=TradeArena <your-gmail@gmail.com>
```

Without mail configured, forgot-password may show an on-screen OTP when `DJANGO_DEBUG=true`.

### Database

If you use the committed SQLite DB:

```bash
python manage.py migrate
```

(Safe to run; applies any new migrations.)

Create a superuser (optional):

```bash
python manage.py createsuperuser
```

### Run API

```bash
python manage.py runserver 7777
```

API base: `http://127.0.0.1:7777/api`

---

## Frontend setup

Open a **second** terminal:

```bash
cd frontend
npm install
npm run dev
```

App: [http://localhost:3333](http://localhost:3333)

The frontend talks to `http://127.0.0.1:7777/api` by default. Override with:

```env
NEXT_PUBLIC_API_URL=http://127.0.0.1:7777/api
```

(in `frontend/.env.local` if needed)

---

## Quick start checklist

1. Clone repo  
2. Backend: venv → `pip install` → copy `.env` → fill secrets → `migrate` → `runserver 7777`  
3. Frontend: `npm install` → `npm run dev`  
4. Open http://localhost:3333 → Sign up as **Trader** or **Viewer**

---

## Project layout

```
TradeArena/
├── backend/          # Django + DRF + JWT
│   ├── accounts/     # Auth, follow, notifications, email OTP
│   ├── trading/      # Wallets, orders, positions, Binance, leaderboard
│   ├── db.sqlite3    # Local database (committed in this repo)
│   └── .env          # Local secrets (not committed)
├── frontend/         # Next.js App Router + Tailwind
└── README.md
```

---

## Notes

- Paper trading only — prices from Binance public APIs; fills are simulated.  
- Never commit `backend/.env` (Gmail / Resend keys).  
- After pulling code changes: restart Django; run `migrate` if migrations were added; run `npm install` if frontend deps changed.
