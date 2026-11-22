# OPD Desk (server edition, PostgreSQL)

Multi-clinic patient registration, appointments, prescriptions and billing. Doctors sign up with Google or
email and password; each sign-up gets its own clinic whose records no other clinic can see. Patients
scan a per-clinic QR code to register themselves.

## Who can see what
- **Public (no login):** only `/register`, the patient registration form. It can only add a request to the
  "Online registrations" inbox. It cannot read or change any record.
- **Doctor:** everything, including prescriptions, clinic settings and user accounts.
- **Staff:** patients, visits (complaint and billing only), appointments, invoices and approving registrations. Diagnoses, visit notes, prescriptions, settings and users are hidden from staff, and staff edits never overwrite them.

## What the doctor sees
The patient's Diagnosis tab is a case sheet: Patient Report / Certificate / Edit Patient at the top, the OP number,
the visit history, Personal Information, one card per note box (latest visit, edited in place), Next visit (date
and time, WhatsApp reminder), then Signatures (patient and doctor).

Dashboard (patient counts, today/this week appointments, recalls due, search, QR, registration link, CSV report),
patient page (registration form with visits, prescriptions, invoices, patient report, medical certificate),
appointments, analytics, settings and help. Patient numbers look like `OP-0001`. Saving a visit with an amount billed
creates its invoice automatically. Only doctors can delete a patient, which also deletes all of that patient's records, so check your record-retention rules first.

## First-time clinic setup
Every new sign-up (Google or email) is sent to `/setup-clinic`, a 3-step form with a live letterhead preview:
1. **Clinic:** name*, tagline, logo, phone/WhatsApp*, email (pre-filled), address* (street, area, city, state, pincode)
2. **Doctor:** full name*, qualifications*, specialization, Medical/Dental Council registration number*
3. **Billing (optional, can be skipped):** default consultation fee, timings, GSTIN, invoice/prescription footer note.
   Timings support several sessions a day (e.g. 10–12 and 3–5) and different hours for other days (e.g. Sunday morning).

The printed letterhead is laid out for A4 (about 700px wide, 12mm margins). "Logo left, contact right" is the default
arrangement; the preview shows the header scaled to A4 width, with a "View at actual size" option.

Until it is finished, `clinics.is_setup_complete` is false: every page redirects to `/setup-clinic`, and the API refuses to
create or change patients, visits, appointments, prescriptions, invoices, registrations, imports and users (HTTP 409).
Staff of a clinic that is not set up see a "waiting for the doctor" screen. Clinics that existed before this feature
are marked as set up automatically. The same fields are edited later under Settings > Clinic Profile.

These profile fields are stored as columns on `clinics` (`name`, `tagline`, `logo`, `phone`, `email`, `addr_street`,
`addr_area`, `city`, `state`, `pincode`, `doctor_name`, `qualifications`, `specialization`, `reg_number`, `consult_fee`,
`timings`, `gstin`, `footer_note`). Other settings (theme, stamp, registration form, lists) stay in the `kv` table.
They print on prescriptions, invoices (with GSTIN), reports, certificates and the patient registration page.

## Prescription medicine list (Settings > Prescription)
Each clinic keeps its own medicine list: type (Tab, Cap, Syp, Inj, Cream...), name, strength, usual dosage, intake and
days, and an "in use" switch. Add one at a time, paste a whole list (one per line, optionally `| dosage | intake | days`),
or copy a ready list (Psychiatry, Dental, Skin / Dermatology, General practice, Diabetes; in `public/medpacks.js`).
Copied medicines belong to the clinic from then on. While writing a prescription, in-use medicines are offered by name
and picking one fills its usual dosage, days and intake. Stored as `medlist` in the clinic settings (no new columns);
a clinic's older plain name list is read in automatically.

## Settings (doctor only)
Cards: Diagnosis and Doctor's Notes (add, rename, remove and reorder the note boxes for each visit, e.g. Diagnosis,
Previous Treatment History, Treatment Plan), medicine list, invoice price list, CSV import of old records, backup download.
Tabs: Clinic Profile, Team, and Patient & Invoice Numbers (number prefixes). Clinic Profile has three cards:
- **Clinic profile & letterhead:** the setup fields plus letterhead design (header arrangement, text and name size,
  colour, optional scanned letterhead), with a live A4 preview. One Save button saves both.
- **Doctor signature & stamp:** signature image, what prints under it, ink colour, stamp lines and a hand-stamp box,
  with a live preview of the bottom of a prescription.
- **Google review requests:** review link and WhatsApp message.
 Logos are resized in the browser to 600px; other images are stored as JPG/PNG under 2MB.

## Bilingual forms (Settings > Bilingual Language)
Pick a second language (Tamil, Hindi, Marathi, Telugu, Bengali, Gujarati, Kannada, Malayalam, Odia, Punjabi, Urdu,
Assamese) or English only. Registration forms (QR page and desk), the consent and the Patient Report then show
"English / second language". Built-in translations live in `public/shared.js` and are a starting point: have a native
speaker check them. Doctors can correct any label, section title or the consent text in Settings > Registration Form.

## Registration form (Settings > Registration Form)
Doctors can add, remove, rename, reorder and mark fields required, use Yes/No questions (a standard 13-item medical
history checklist can be added in one click; any Yes shows as an alert on the patient page), add sections, and turn the patient signature box on or off.
The page is laid out as: form sections (Personal Information, Medical History, ...), Patient consent, Second language,
Patient signature, then Save. Every form shows one field per line.
Each new visit (+ Visit today) asks "Any change in your medical history since the last visit?", shows the yes/no
questions pre-filled from last time (editable when the answer is Yes), and needs the consent ticked again; the visit
keeps its own answers and consent date, a doctor can tick "reviewed", and changes update the patient's alerts.
Every form ends with a consent the patient must agree to; the date is saved with the patient and printed on the report. Name, age, sex and phone are locked.
The same form is used for adding patients at the desk and for the public QR page. When the signature is on, patients
sign with a finger on the QR page and the signature prints on the Patient Report. Uploading a photo or PDF of a paper
form for automatic extraction is not included.

## Requirements
Node 18+ and a PostgreSQL 12+ database. Tables are created automatically on first start.

## Run locally
    npm install
    DATABASE_URL=postgres://user:password@localhost:5432/opd INSECURE_COOKIES=1 npm start
Open http://localhost:3000/signup, create a doctor account, then add clinic details under Settings.
(`INSECURE_COOKIES=1` is for local http only.)

## Deploy
**Easiest (any VPS with Docker):** edit the password in `docker-compose.yml`, then
    docker compose up -d --build
and put HTTPS in front (Caddy or nginx, proxying to port 3000).

**Managed hosting (Render, Railway, Fly, etc.):** create a managed PostgreSQL database, deploy this folder
(Dockerfile included) and set `DATABASE_URL` to the database's connection string. If the provider requires SSL
and the connection fails, also set `PGSSL=1`.

The site must be served over HTTPS. Then open `https://your-domain/signup`, create the doctor account, and print
the QR from the dashboard (Registration QR Code). Each clinic gets its own link, `https://your-domain/register/<code>`;
the clinic that existed before multi-clinic support keeps the plain `https://your-domain/register`, so QR codes
already printed keep working. Finalise the domain before printing: the QR encodes the address you were using.

## Environment variables
- `DATABASE_URL`  PostgreSQL connection string (required)
- `PGSSL=1`  use SSL to the database (add `PGSSL_STRICT=1` to also verify the certificate)
- `TRUST_PROXY=1`  when behind a proxy/load balancer so rate limits see real IPs (Docker sets it)
- `INSECURE_COOKIES=1`  local http testing only; never in production
- `APP_URL`  public address of the app, e.g. `https://api.myclinicdesk.com` (used in Google sign-in and reset links)
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`  turn on "Continue with Google" (see below)
- `RESEND_API_KEY`, `MAIL_FROM`  turn on "Forgot password?" emails, e.g. `MAIL_FROM="Clinic Desk <noreply@yourdomain.com>"`
- `APP_NAME`  name used in emails, default `Clinic Desk`
- `CLINIC_TZ`  default `Asia/Kolkata`
- `PORT`  default 3000

## Backups
Use PostgreSQL's own tools, daily, and test a restore once:
    pg_dump "$DATABASE_URL" -Fc -f clinic-$(date +%F).dump
    pg_restore -d "$DATABASE_URL" --clean clinic-YYYY-MM-DD.dump
Managed databases usually offer automatic backups: turn them on. Backups contain patient records, so keep them private.

## Sign-up, sign-in and password reset
- **Sign up** at `/signup` with Google or with name, clinic name, email and password. Each sign-up creates a new,
  separate clinic and its first doctor account (with the usual free trial).
- **Sign in** at `/` with Google, or with email (or the old username) and password.
- **Forgot password?** sends a single-use reset link to the account's email. The link expires after 1 hour; using it
  signs out every other session. The reply is the same whether or not the email has an account.
- Staff added under Settings > Team can be given an email so they can reset their own password too.
- Accounts without an email (created before this change) can still be reset on the server:
  `DATABASE_URL=... node reset-password.js <username> <new-password>`

### Setting up Google sign-in
1. In Google Cloud Console > APIs & Services, configure the OAuth consent screen (External, app name, support email).
2. Credentials > Create credentials > OAuth client ID > Web application.
3. Authorised redirect URI: `https://<your-domain>/auth/google/callback` (exactly; must match `APP_URL`).
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. Publish the consent screen so anyone can sign in.

### Setting up reset emails (Resend)
1. Create an account at resend.com, add and verify your sending domain (DNS records).
2. Create an API key and set `RESEND_API_KEY`, and `MAIL_FROM` to an address on that domain.
   (Without a verified domain Resend only delivers to your own address, which is enough for testing.)

### Upgrading an existing database
On first start the server moves everything that already exists (accounts, patients, settings, numbering) into
clinic 1. Take a `pg_dump` backup before deploying this version.

## Security notes
Passwords are hashed (scrypt); sessions are HttpOnly SameSite=Strict cookies that expire after 12 hours;
login is rate limited; the public form is rate limited, size limited and capped at 300 pending requests.
Rate limits are kept in memory, so run a single app instance. Behind a proxy (Railway, Render, Docker) set
`TRUST_PROXY=1`, otherwise every visitor shares one rate limit. Records are not encrypted inside the database:
restrict access to the database and its backups. Patient data is personal health data, so keep the server
patched and review India's DPDP Act obligations (consent, retention, breach reporting) with your advisor.
Not included: SMS, two-factor login, an audit viewer (actions are logged in
the `audit` table).

## Google Drive backup

Settings › **Google Drive Backup** lets a doctor connect a Google account. Every night from about 2 AM (clinic time zone, `CLINIC_TZ`, default Asia/Kolkata) the server saves `MyClinicDesk_Backup_YYYY-MM-DD.zip` to a **MyClinicDesk Backups** folder in that Drive:

- `Patient_Reports/OP-0001_Name.pdf`: one Patient Report per patient (pdfkit)
- `Clinic_Records_YYYY-MM-DD.xlsx`: Patients, Visits, Prescriptions and Bills sheets (exceljs)

The newest 30 backups are kept. A failed night is retried every hour. **Back Up Now** runs one immediately. It is available on an active trial or the paid plan. The app uses the `drive.file` permission, so it can only see the files it creates. Refresh tokens are stored AES-256-GCM encrypted in the `gdrive` table. PDFs use the built-in PDF fonts, so text in Indian scripts shows as `?` in the PDF but is kept in full in the Excel file.

Setup, using the same Google Cloud project and OAuth client as "Continue with Google":

1. APIs & Services › Library › **Google Drive API** › Enable.
2. Credentials › your OAuth client › Authorised redirect URIs › add `https://<your-app>/auth/gdrive/callback`.
3. OAuth consent screen › Data access › add the scope `https://www.googleapis.com/auth/drive.file`.
4. Railway › Variables › add `GDRIVE_TOKEN_KEY`, a random value of at least 32 characters:
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   Keep it fixed. If it changes, every clinic has to reconnect Google Drive.

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `APP_URL` must also be set.
