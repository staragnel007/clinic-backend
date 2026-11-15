# OPD Desk (server edition)

Single-clinic patient registration, appointments, prescriptions and billing, with doctor/staff login
and a QR code patients scan to register themselves.

## Who can see what
- **Public (no login):** only `/register`, the patient registration form. It can only add a request to the
  "Online registrations" inbox. It cannot read or change any record.
- **Doctor:** everything, including prescriptions, clinic settings and user accounts.
- **Staff:** patients, appointments, billing and approving registrations. No prescriptions, settings or users.

## Run locally
    npm install
    INSECURE_COOKIES=1 npm start        # http://localhost:3000  (INSECURE_COOKIES only for local http)
Open it, create the first doctor account, then add your clinic details under Settings.

## Deploy (must be HTTPS and must keep /data on a persistent disk)
Docker (any VPS, or Render / Railway / Fly with a persistent volume mounted at /data):

    docker build -t opd-desk .
    docker run -d -p 3000:3000 -v opd-data:/data --restart unless-stopped opd-desk

Put it behind HTTPS (Caddy, nginx, or your host's built-in TLS). Then open `https://your-domain/`,
create the doctor account, and print the QR from Settings > Patient registration QR (it points to
`https://your-domain/register`). Set up the final domain before printing: the QR encodes the address you used.

## Settings (environment variables)
- `DATA_DIR`  where `clinic.db` lives (default `./data`; Docker uses `/data`)
- `TRUST_PROXY=1`  when behind a proxy/load balancer (so rate limits see real IPs; Docker sets it)
- `INSECURE_COOKIES=1`  local http testing only; never in production
- `CLINIC_TZ`  default `Asia/Kolkata`

## Backups
All data is one SQLite file: `DATA_DIR/clinic.db`. Back it up daily, for example:
    sqlite3 /data/clinic.db ".backup '/backups/clinic-$(date +%F).db'"
Keep backups private: they contain patient records. Test a restore once.

## Forgot a password
On the server: `node reset-password.js <username> <new-password>`

## Security notes
Passwords are hashed (scrypt); sessions are HttpOnly SameSite=Strict cookies that expire after 12 hours;
login is rate limited; the public form is rate limited, size limited and capped at 300 pending requests.
Records are not encrypted inside the database file, so restrict access to the server and backups.
Patient data is personal health data: keep the server patched, and review India's DPDP Act obligations
(consent, retention, breach reporting) with your advisor. Not included: SMS/email, password reset by email,
two-factor login, an audit viewer (actions are logged in the `audit` table).
