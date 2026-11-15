# OPD Desk (server edition, PostgreSQL)

Single-clinic patient registration, appointments, prescriptions and billing, with doctor/staff login
and a QR code patients scan to register themselves.

## Who can see what
- **Public (no login):** only `/register`, the patient registration form. It can only add a request to the
  "Online registrations" inbox. It cannot read or change any record.
- **Doctor:** everything, including prescriptions, clinic settings and user accounts.
- **Staff:** patients, visits (complaint and billing only), appointments, invoices and approving registrations. Diagnoses, visit notes, prescriptions, settings and users are hidden from staff, and staff edits never overwrite them.

## What the doctor sees
Dashboard (patient counts, today/this week appointments, recalls due, search, QR, registration link, CSV report),
patient page (registration form with visits, prescriptions, invoices, patient report, medical certificate),
appointments, analytics, settings and help. Patient numbers look like `OP-0001`. Saving a visit with an amount billed
creates its invoice automatically. Only doctors can delete a patient, which also deletes all of that patient's records, so check your record-retention rules first.

## Requirements
Node 18+ and a PostgreSQL 12+ database. Tables are created automatically on first start.

## Run locally
    npm install
    DATABASE_URL=postgres://user:password@localhost:5432/opd INSECURE_COOKIES=1 npm start
Open http://localhost:3000, create the first doctor account, then add clinic details under Settings.
(`INSECURE_COOKIES=1` is for local http only.)

## Deploy
**Easiest (any VPS with Docker):** edit the password in `docker-compose.yml`, then
    docker compose up -d --build
and put HTTPS in front (Caddy or nginx, proxying to port 3000).

**Managed hosting (Render, Railway, Fly, etc.):** create a managed PostgreSQL database, deploy this folder
(Dockerfile included) and set `DATABASE_URL` to the database's connection string. If the provider requires SSL
and the connection fails, also set `PGSSL=1`.

The site must be served over HTTPS. Then open `https://your-domain/`, create the doctor account, and print
the QR from Settings > Patient registration QR (it points to `https://your-domain/register`). Finalise the
domain before printing: the QR encodes the address you were using.

## Environment variables
- `DATABASE_URL`  PostgreSQL connection string (required)
- `PGSSL=1`  use SSL to the database (add `PGSSL_STRICT=1` to also verify the certificate)
- `TRUST_PROXY=1`  when behind a proxy/load balancer so rate limits see real IPs (Docker sets it)
- `INSECURE_COOKIES=1`  local http testing only; never in production
- `CLINIC_TZ`  default `Asia/Kolkata`
- `PORT`  default 3000

## Backups
Use PostgreSQL's own tools, daily, and test a restore once:
    pg_dump "$DATABASE_URL" -Fc -f clinic-$(date +%F).dump
    pg_restore -d "$DATABASE_URL" --clean clinic-YYYY-MM-DD.dump
Managed databases usually offer automatic backups: turn them on. Backups contain patient records, so keep them private.

## Forgot a password
On the server: `DATABASE_URL=... node reset-password.js <username> <new-password>`

## Security notes
Passwords are hashed (scrypt); sessions are HttpOnly SameSite=Strict cookies that expire after 12 hours;
login is rate limited; the public form is rate limited, size limited and capped at 300 pending requests.
Rate limits are kept in memory, so run a single app instance. Records are not encrypted inside the database:
restrict access to the database and its backups. Patient data is personal health data, so keep the server
patched and review India's DPDP Act obligations (consent, retention, breach reporting) with your advisor.
Not included: SMS/email, password reset by email, two-factor login, an audit viewer (actions are logged in
the `audit` table).
