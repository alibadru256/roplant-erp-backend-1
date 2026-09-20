# Roplant Services Limited ERP — Backend

Real Express + PostgreSQL API. Everything here is written but **not yet run or tested**
against a live database — I have no network access in the environment this was written in,
so `npm install`, database migrations, and starting the server all need to happen in your
Codespace, where real network and Postgres access exist.

## Production deployment checklist

Everything below is **verified by code inspection** — the environment this was written in has
no network access and no PostgreSQL, so none of it has actually been run end-to-end. Each step
that says "requires testing after deployment" means exactly that: I could not confirm it here.

1. **Install dependencies**: `cd backend && npm install`
2. **Configure environment variables** (see the full table below) — copy `.env.example` to
   `.env` for local use, or set them directly in your host's dashboard for production. Required
   at minimum: `DATABASE_URL`, `JWT_SECRET`. `CORS_ORIGIN` is required once `NODE_ENV=production`
   — the server refuses to start without it rather than defaulting to an open CORS policy.
3. **Connect PostgreSQL** — any provider works (Neon, Supabase, Railway's own Postgres, RDS).
   Put its connection string in `DATABASE_URL`.
4. **Run migrations 001 → 006**: `npm run migrate` — this now runs all schema migrations in
   order automatically (`001`, `003`, `004`, `005`, `006`; `002` is demo seed data, run
   separately below). *Verified by inspection that the script lists every schema migration in
   the correct dependency order; not verified against a live database.*
5. **Seed the database** (optional, demo data): `npm run seed`, after generating real password
   hashes per the section above. *Requires testing after deployment.*
6. **Start the backend**: `npm start` (production) or `npm run dev` (local, auto-restart).
   Binds to `process.env.PORT` with no host restriction — compatible with Railway/Render/Fly,
   which inject their own `PORT` and require binding on all interfaces. *Verified by inspection.*
7. **Test the health endpoint**: `curl https://your-backend-url/api/health` → expect
   `{"status":"ok","database":"connected",...}`. *Requires testing after deployment.*
8. **Test login**: `curl -X POST https://your-backend-url/api/auth/login -H "Content-Type: application/json" -d '{"email":"...","password":"..."}'`
   → expect a `token` and `user` back. *Requires testing after deployment.*
9. **Configure the frontend's API URL**: set `VITE_API_URL=https://your-backend-url/api` in the
   frontend's environment before building — see `frontend/.env.example`. The build now fails
   loudly if this is missing in production mode, instead of silently shipping `localhost`.
10. **Build the frontend**: `cd frontend && npm install && npm run build` → outputs to `dist/`.
11. **Deploy the frontend**: serve `dist/` from any static host (Vercel, Netlify, Cloudflare
    Pages, or the backend itself via `express.static` if you prefer a single deployment).

## Setup (run these in your Codespace terminal, in order)

```bash
cd backend
npm install
cp .env.example .env
```

Edit `.env`:
- `DATABASE_URL` — paste your Neon/Supabase connection string
- `JWT_SECRET` — generate one with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
  ```

## Create the database schema

```bash
npm run migrate
```

This now runs every schema migration in the correct order automatically: `001_init.sql` (core
tables), `003_accounting_and_extras.sql` (Chart of Accounts, General Ledger, stocktake,
credit/debit note numbering), `004_schema_audit_fixes.sql` (categories table, customer/supplier
codes + soft delete + opening balances, a real customer_id foreign key on quotations),
`005_owner_flag.sql` (the owner-only permission gate), and `006_settings_letterhead_fields.sql`
(company letterhead fields) — creating every table, constraint, and index the app uses. It
stops immediately if any single migration fails, rather than continuing on a partial schema.

## Generate real passwords for the seeded users

The seed file ships with placeholder password hashes (a real bcrypt hash can't be generated
without running Node with bcryptjs installed, which needed this `npm install` step first).
For each user you want to log in as, run:

```bash
npm run hash -- "YourChosenPassword"
```

Copy the printed hash and paste it in place of the matching `'*** RUN scripts/hash-password.js ***'`
placeholder in `db/migrations/002_seed.sql`, then load the seed data:

```bash
npm run seed
```

## Run the server

```bash
npm run dev
```

Then check it's alive:

```bash
curl http://localhost:4000/api/health
```

Expected response: `{"status":"ok","database":"connected", ...}`. If you see a connection
error instead, double-check `DATABASE_URL` in `.env`.

## Test login

```bash
curl -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ronald@roplantservices.com","password":"YourChosenPassword"}'
```

You should get back a `token` and `user` object. Save the token and use it on every other
request as `Authorization: Bearer <token>`.

## What's real vs. what's next

**Implemented and transaction-safe:** authentication (bcrypt + JWT + login attempt lockout),
products/inventory with a full stock ledger, POS sales (atomic — stock, customer balance, and
audit log all commit together or not at all, row-level locking prevents overselling under
concurrent requests), purchasing with partial-receive support and over-receipt prevention,
customers/suppliers with balances and statements, returns with correct stock/balance reversal,
dashboard KPIs computed live from the database with role-gated financial figures, quotations,
settings, audit log, and reports — all reading real data, nothing hardcoded.

**Not yet built** (per the phased plan): the frontend still needs to be rewired to call these
endpoints instead of local React state (currently `roplant-inventory-system.jsx` is UI-only);
a full general-ledger accounting engine (Trial Balance/P&L/Balance Sheet); approval workflows;
physical stocktake; notifications; automated test suite; barcode/QR label printing.

## Production hardening added in this pass

- **Pagination** on sales, purchasing, returns, customers, suppliers, quotations — none of
  these fetch unbounded result sets anymore (`?page=1&pageSize=50`).
- **Optimistic concurrency** on product edits — you must send back `expectedUpdatedAt` (the
  `updated_at` value you loaded the product with); a conflicting concurrent edit returns 409
  instead of silently overwriting.
- **Rate limiting** — strict on `/api/auth/login` (20 attempts/15min per IP, on top of the
  existing 5-failed-attempt per-account lockout), general on the rest of the API (300 req/min).
- **Fail-closed CORS** — `NODE_ENV=production` without `CORS_ORIGIN` set now refuses to start,
  instead of defaulting to allow-all.
- **Refresh tokens** — access tokens now expire in 15 minutes; a hashed, revocable refresh
  token (30 days) issued alongside it via `/api/auth/refresh` lets a session extend without
  re-entering a password, and `/api/auth/logout-all` revokes every session for a user.
- **Real-time updates** — `/api/events/stream` (Server-Sent Events, needs no new dependency)
  pushes `sale.completed`, `stock.received`, `stock.adjusted`, `return.processed`, and
  `stocktake.approved` events to every connected browser tab the instant they happen, so
  Inventory's screen reflects a sale Sales just completed without a manual refresh.
- **Input validation (Zod)** on login, checkout, product create/adjust, PO create/receive, and
  returns — one declarative schema per endpoint instead of scattered manual `if` checks.
- **Structured JSON logging** (`src/utils/logger.js`) — every request and every error is one
  parseable JSON line, ready for any log aggregator, instead of raw `console.error`.
- **Crash resilience** — `uncaughtException`/`unhandledRejection` handlers log and exit cleanly
  so a process manager restarts into a known-good state; `SIGTERM`/`SIGINT` trigger a graceful
  shutdown that finishes in-flight requests and closes the database pool before exiting.
- **Backups** — `npm run backup` runs `scripts/backup.sh` (a real `pg_dump` wrapper with
  14-backup retention); `.github/workflows/backup.yml` runs it automatically every day via
  GitHub Actions and uploads the dump as a workflow artifact (set the `DATABASE_URL` repo
  secret for this to work — see the workflow file for the exact step).
- **Image storage guardrail** — base64 product images over 500KB are rejected server-side with
  a clear message pointing at real object storage (S3/Cloudinary) as the production path;
  this stops the database from silently bloating with embedded photos.

### Verification performed on these additions
`npm test` — 30/30 pass (5 new pagination tests added). Every backend file re-passed `node --check`.
A custom cross-check confirmed every internal `require({...})` destructure matches what the
target file actually exports (catches the exact class of typo `--check` can't see), and that
every helper function called in a route is actually imported into that file. I still could not
start the server or hit it with a real HTTP request — that remains the one thing only your
Codespace can verify, for the same no-network reason as before.

- **Real PDF generation** — `GET /api/sales/:id/pdf` and `GET /api/quotations/:id/pdf` stream an
  actual PDF file (via `pdfkit`, pure JS, no native build step) — a genuine downloadable/emailable
  document, distinct from the frontend's browser-print-to-PDF flow (which still works too, for a
  quick on-screen print).

- **Email notifications** — real SMTP sending via `nodemailer` (`src/utils/email.js`), triggered on
  low stock after a sale and on new user creation. **This requires your own SMTP credentials** in
  `.env` (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `OWNER_EMAIL`) to actually send anything — without
  them, it logs what would have been sent and the app keeps working normally. I could not test
  actual delivery in the sandbox this was written in (no network, and no SMTP account to send
  through) — please confirm a real email arrives once you add credentials, the same way you
  confirmed `/api/health` and login earlier.

- **WhatsApp integration — two tiers, both real:**
  1. *Works right now, zero setup*: the frontend's WhatsApp page uses WhatsApp's official
     "click to chat" link (`wa.me`) — opens WhatsApp with a balance/statement or invoice
     summary pre-typed to the customer's number. A person still taps Send; it can't attach a
     file (link to a downloaded PDF and attach manually in the chat instead).
  2. *Needs your own Meta-verified WhatsApp Business Account*: `src/utils/whatsapp.js` and the
     `/api/customers/:id/send-whatsapp` and `/api/sales/:id/send-whatsapp` endpoints use the
     real Cloud API — this can send with no human tapping Send, and CAN attach the invoice PDF
     directly, but only once `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`, and (for PDF attachments)
     a real public `PUBLIC_BASE_URL` are set. Without them, it reports plainly that it wasn't
     sent rather than pretending to.

## Every endpoint

| Method | Path | Who |
|---|---|---|
| POST | /api/auth/login | Anyone (rate limited) |
| POST | /api/auth/refresh | Anyone with a valid refresh token |
| POST | /api/auth/logout-all | Authenticated |
| GET | /api/events/stream | Valid token as ?token=... — SSE, not rate limited |
| POST | /api/auth/logout | Authenticated |
| GET | /api/products | Authenticated |
| POST | /api/products | Admin, Manager, Inventory |
| PUT | /api/products/:id | Admin, Manager, Inventory |
| POST | /api/products/:id/adjust | Admin, Manager, Inventory |
| GET | /api/sales | Authenticated |
| POST | /api/sales | Admin, Manager, Sales |
| GET | /api/purchasing | Authenticated |
| POST | /api/purchasing | Admin, Manager, Inventory |
| POST | /api/purchasing/:id/receive | Admin, Manager, Inventory |
| GET/POST | /api/customers | Authenticated / Admin, Manager, Sales |
| PUT | /api/customers/:id | Admin, Manager |
| DELETE | /api/customers/:id | Admin (soft delete — deactivates, never destroys) |
| GET | /api/customers/:id/statement | Authenticated |
| GET/POST | /api/suppliers | Authenticated / Admin, Manager |
| PUT | /api/suppliers/:id | Admin, Manager |
| DELETE | /api/suppliers/:id | Admin (soft delete) |
| POST | /api/suppliers/:id/pay | Admin, Manager, Accountant |
| GET/POST | /api/returns | Authenticated / Admin, Manager, Sales, Inventory |
| GET | /api/dashboard | Authenticated (figures gated by role) |
| GET/POST | /api/quotations | Authenticated / Admin, Manager, Sales, Accountant |
| GET | /api/quotations/:id/pdf | Authenticated |
| GET | /api/sales/:id/pdf | Authenticated |
| GET/PUT | /api/settings | Authenticated / Admin, Manager |
| GET | /api/audit | Admin, Manager |
| GET | /api/reports/inventory-valuation, /sales, /profit, /customer-balances, /supplier-balances, /low-stock | Admin, Manager, Accountant |
| GET | /api/reports/trial-balance, /profit-and-loss, /balance-sheet | Admin, Manager, Accountant |
| GET/POST/PUT | /api/users | Admin only |
| GET/POST | /api/stocktake | Authenticated / Admin, Manager, Inventory, Warehouse |
| PUT | /api/stocktake/:id/count | Admin, Manager, Inventory, Warehouse |
| POST | /api/stocktake/:id/approve | Admin, Manager |
| GET | /api/barcode/:id/qr, /api/barcode/lookup/:code | Authenticated |
| POST | /api/barcode/labels | Authenticated |
| GET | /api/notifications | Authenticated |
| POST | /api/customers/:id/pay | Admin, Manager, Accountant, Sales |
| POST | /api/customers/:id/send-whatsapp | Admin, Manager, Sales, Accountant |
| GET | /api/sales/:id/send-whatsapp | Authenticated |
