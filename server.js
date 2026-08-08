const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { Resend } = require('resend');

const app = express();
app.set('trust proxy', 1); // Railway sits behind a proxy — needed for req.ip to be the real client IP

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// DATA_DIR defaults to a local folder for dev; on Railway it's pointed at
// the mounted volume so enquiries survive a redeploy (the container's own
// disk is wiped on every deploy, the volume isn't).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ENQUIRIES_FILE = path.join(DATA_DIR, 'enquiries.json');
const TMP_FILE = `${ENQUIRIES_FILE}.tmp`;

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ENQUIRIES_FILE)) {
  fs.writeFileSync(ENQUIRIES_FILE, '[]');
}

// Loud on purpose: if DATA_DIR isn't actually pointed at the mounted volume
// (e.g. missing/typo'd in a fresh Railway environment), enquiries silently
// fall back to the container's ephemeral disk and vanish on next redeploy.
// This line is what makes that visible in Railway's log viewer instead of
// discovered later as "why did all the enquiries disappear."
console.log(`[Startup] Enquiries file: ${ENQUIRIES_FILE} (persisted volume: ${Boolean(process.env.DATA_DIR)})`);

// Only set if RESEND_API_KEY is configured — lets the form keep working
// (saving to enquiries.json) even before the key is added on Railway.
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
if (!resend) {
  console.warn('[Startup] RESEND_API_KEY not set — email notifications are disabled.');
}

async function sendEnquiryNotification(entry) {
  if (!resend) {
    console.warn('[Resend] RESEND_API_KEY not set — skipping email notification.');
    return;
  }
  const text = `New investor enquiry received:

Name: ${entry.name}
Location: ${entry.location}
Occupation: ${entry.occupation}
Why interested: ${entry.why}
Email: ${entry.email}
Time: ${entry.timestamp}`;

  await resend.emails.send({
    from: 'onboarding@resend.dev',
    to: 'edack.david@gmail.com',
    subject: 'New EdackWeb Investor Enquiry',
    text: text
  });
}

// --- Serialized, atomic storage --------------------------------------------
//
// All writes to enquiries.json are chained through this queue so two
// concurrent requests can never race on a read-modify-write (previously the
// second write would silently clobber the first, dropping an enquiry with
// no error to either submitter). Each write lands in a temp file and is
// renamed into place, so a crash mid-write can never leave a truncated or
// corrupt file behind.

let writeQueue = Promise.resolve();

function appendEnquiry(entry) {
  writeQueue = writeQueue.then(() => {
    let enquiries;
    try {
      enquiries = JSON.parse(fs.readFileSync(ENQUIRIES_FILE, 'utf8'));
    } catch (err) {
      // Don't silently reset history to [] and overwrite it on a bad read —
      // that turns one corrupt read into permanent data loss. Preserve the
      // corrupt file for forensic recovery and start fresh going forward.
      const corruptPath = `${ENQUIRIES_FILE}.corrupted-${Date.now()}`;
      console.error(`[Storage] enquiries.json failed to parse — preserving as ${corruptPath} and starting fresh.`, err);
      try {
        fs.renameSync(ENQUIRIES_FILE, corruptPath);
      } catch (renameErr) {
        console.error('[Storage] Could not preserve corrupted file:', renameErr);
      }
      enquiries = [];
    }
    enquiries.push(entry);
    fs.writeFileSync(TMP_FILE, JSON.stringify(enquiries, null, 2));
    fs.renameSync(TMP_FILE, ENQUIRIES_FILE); // same-volume rename is atomic
  });
  return writeQueue;
}

// --- Duplicate-submission guard ---------------------------------------------
//
// Covers double-clicks and client retries after a slow/timed-out response:
// the same details submitted again within a short window are treated as one
// enquiry rather than a duplicate record + duplicate notification email.

const recentSubmissions = new Map(); // fingerprint -> expiry timestamp
const DEDUPE_WINDOW_MS = 30 * 1000;

function isDuplicate(entry) {
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${entry.email}|${entry.name}|${entry.location}|${entry.occupation}|${entry.why}`)
    .digest('hex');
  const now = Date.now();
  for (const [key, expiry] of recentSubmissions) {
    if (expiry < now) recentSubmissions.delete(key);
  }
  if (recentSubmissions.has(fingerprint)) return true;
  recentSubmissions.set(fingerprint, now + DEDUPE_WINDOW_MS);
  return false;
}

// --- Rate limiting -----------------------------------------------------------
//
// No auth/CAPTCHA on this endpoint, so a simple per-IP sliding window stops a
// trivial spam script from blocking the event loop, filling the volume, or
// burning through the Resend send quota.

const submissionTimes = new Map(); // ip -> timestamps[]
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 5;

function isRateLimited(ip) {
  const now = Date.now();
  const times = (submissionTimes.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  times.push(now);
  submissionTimes.set(ip, times);
  return times.length > RATE_LIMIT_MAX;
}

// --- Field sanitization -------------------------------------------------------
//
// Caps length (an unbounded field can grow the stored file/email
// indefinitely) and neutralizes a leading =/+/-/@, which spreadsheet
// software treats as the start of a formula if enquiries.json is ever
// opened or exported as a CSV (CSV-formula injection).

const MAX_SHORT_FIELD = 300;
const MAX_LONG_FIELD = 3000;

function sanitize(value, maxLength) {
  const stripped = String(value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
  const capped = stripped.slice(0, maxLength);
  return /^[=+\-@]/.test(capped) ? `'${capped}` : capped;
}

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.post('/api/enquiry', async (req, res) => {
  const { name, location, occupation, why, email } = req.body || {};

  // Trim before checking so whitespace-only input ("   ") is correctly
  // rejected instead of passing the old truthy-on-untrimmed-string check.
  if (
    !String(name || '').trim() ||
    !String(location || '').trim() ||
    !String(occupation || '').trim() ||
    !String(email || '').trim()
  ) {
    return res.status(400).json({ ok: false, error: 'Please fill in all required fields.' });
  }

  if (isRateLimited(req.ip)) {
    return res.status(429).json({ ok: false, error: 'Too many submissions — please try again later.' });
  }

  const entry = {
    name: sanitize(name, MAX_SHORT_FIELD),
    location: sanitize(location, MAX_SHORT_FIELD),
    occupation: sanitize(occupation, MAX_SHORT_FIELD),
    why: sanitize(why || '', MAX_LONG_FIELD),
    email: sanitize(email, MAX_SHORT_FIELD),
    timestamp: new Date().toISOString()
  };

  if (isDuplicate(entry)) {
    console.log('[Investor enquiry] Duplicate submission ignored:', entry.email);
    return res.status(201).json({ ok: true, name: entry.name });
  }

  try {
    await appendEnquiry(entry);
  } catch (err) {
    console.error('Failed to save enquiry:', err);
    return res.status(500).json({ ok: false, error: 'Something went wrong saving your details. Please try again.' });
  }

  console.log('[Investor enquiry]', entry);

  // The enquiry is already safely on disk at this point — an email hiccup
  // (bad key, Resend outage, etc.) must never turn into a failed submission
  // for the person filling in the form.
  try {
    await sendEnquiryNotification(entry);
  } catch (err) {
    console.error('[Resend] Failed to send notification email:', err);
  }

  res.status(201).json({ ok: true, name: entry.name });
});

app.get('/healthz', (req, res) => {
  res.status(200).json({ ok: true });
});

// No catch-all here on purpose: express.static already serves
// public/index.html for "/" by default, and this site has no other pages
// or client-side routes to fall back for. A blanket app.get('*', ...) would
// return 200-with-index.html for *any* path — including /server.js and
// /package.json — which defeats the point of restricting static serving
// to public/ in the first place.

// Malformed JSON bodies throw inside express.json() before any route runs;
// without this, Express's default HTML error page breaks the client's
// res.json() parsing of what's supposed to be a JSON error contract.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: 'Invalid request.' });
  }
  console.error('[Unhandled error]', err);
  res.status(500).json({ ok: false, error: 'Something went wrong. Please try again.' });
});

// Log loudly before the process exits so the cause is visible in Railway's
// log viewer instead of just "the app restarted" with no explanation.
process.on('uncaughtException', (err) => {
  console.error('[Fatal] Uncaught exception:', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[Fatal] Unhandled rejection:', err);
  process.exit(1);
});

app.listen(PORT, () => {
  console.log(`EdackWeb investor page running on port ${PORT}`);
});
