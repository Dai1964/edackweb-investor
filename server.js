const path = require('path');
const fs = require('fs');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// DATA_DIR defaults to a local folder for dev; on Railway it's pointed at
// the mounted volume so enquiries survive a redeploy (the container's own
// disk is wiped on every deploy, the volume isn't).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ENQUIRIES_FILE = path.join(DATA_DIR, 'enquiries.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ENQUIRIES_FILE)) {
  fs.writeFileSync(ENQUIRIES_FILE, '[]');
}

app.use(express.json());
app.use(express.static(__dirname));

app.post('/api/enquiry', (req, res) => {
  const { name, location, occupation, why, preferredContact, contactDetails } = req.body || {};

  if (!name || !location || !occupation || !contactDetails) {
    return res.status(400).json({ ok: false, error: 'Please fill in all required fields.' });
  }

  const entry = {
    name: String(name).trim(),
    location: String(location).trim(),
    occupation: String(occupation).trim(),
    why: String(why || '').trim(),
    preferredContact: String(preferredContact || '').trim(),
    contactDetails: String(contactDetails).trim(),
    timestamp: new Date().toISOString()
  };

  let enquiries = [];
  try {
    enquiries = JSON.parse(fs.readFileSync(ENQUIRIES_FILE, 'utf8'));
  } catch (err) {
    enquiries = [];
  }
  enquiries.push(entry);

  try {
    fs.writeFileSync(ENQUIRIES_FILE, JSON.stringify(enquiries, null, 2));
  } catch (err) {
    console.error('Failed to save enquiry:', err);
    return res.status(500).json({ ok: false, error: 'Something went wrong saving your details. Please try again.' });
  }

  console.log('[Investor enquiry]', entry);
  res.status(201).json({ ok: true, name: entry.name });
});

// Single-page site — every other route serves the same file.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`EdackWeb investor page running on port ${PORT}`);
});
