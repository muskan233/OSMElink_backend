import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

/* ✅ REQUIRED: Render dynamic port */
const PORT = process.env.PORT || 5000;

/* ✅ REQUIRED: absolute DB path */
const DB_FILE = path.join(__dirname, 'fleet_db.json');

const TOR_BASE_URL = 'https://torapis.tor-iot.com';

/* ✅ REQUIRED: env variables (set in Render dashboard) */
const TOR_USER = process.env.TOR_USER;
const TOR_PASS = process.env.TOR_PASS;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '100mb' }));

let vehicleStore = {};
let customerStore = {};
let dealerStore = {};
let alertStore = {};
let userStore = {
  admin: {
    username: 'admin',
    emailId: 'admin@osme.com',
    password: 'Osme@2025',
    role: 'Admin',
    status: 'Active',
    isActive: true
  }
};

const syncJobs = {};

/* ---------------- DB LOAD ---------------- */
const loadDatabase = () => {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(data);
      vehicleStore = parsed.vehicles || {};
      customerStore = parsed.customers || {};
      dealerStore = parsed.dealers || {};
      alertStore = parsed.alerts || {};
      if (parsed.users) userStore = { ...userStore, ...parsed.users };
    }
  } catch (err) {
    console.error('[DB LOAD ERROR]', err.message);
  }
};

loadDatabase();

/* ---------------- DB SAVE ---------------- */
const persistData = () => {
  try {
    fs.writeFileSync(
      DB_FILE,
      JSON.stringify(
        {
          vehicles: vehicleStore,
          customers: customerStore,
          dealers: dealerStore,
          users: userStore,
          alerts: alertStore
        },
        null,
        2
      )
    );
  } catch (err) {
    console.error('[DB SAVE ERROR]', err.message);
  }
};

/* ---------------- TOR AUTH ---------------- */
async function getTorToken() {
  try {
    const res = await axios.post(
      `${TOR_BASE_URL}/Auth/login`,
      { username: TOR_USER, password: TOR_PASS },
      { timeout: 10000 }
    );
    return res.data?.token || res.data?.data?.token || res.data?.result?.token;
  } catch (e) {
    console.error('[TOR AUTH FAILED]');
    return null;
  }
}

/* ================= VEHICLES ================= */

app.get('/api/vehicles', (req, res) => {
  res.json(
    Object.values(vehicleStore).map(({ history, alerts, ...rest }) => rest)
  );
});

app.put('/api/vehicles/:id', (req, res) => {
  const { id } = req.params;
  const existing = vehicleStore[id] || { history: [], alerts: [] };

  vehicleStore[id] = { ...existing, ...req.body, id };
  persistData();

  res.json({ success: true });
});

app.get('/api/telemetry/:id', (req, res) => {
  const vehicle = vehicleStore[req.params.id];
  if (vehicle) res.json(vehicle);
  else res.status(404).json({ error: 'Vehicle not found' });
});

app.post('/api/telemetry/bulk', (req, res) => {
  const batch = req.body;
  if (!Array.isArray(batch)) return res.status(400).end();

  batch.forEach(node => {
    if (!node.id) return;

    const existing = vehicleStore[node.id] || { history: [], alerts: [] };
    const history = existing.history || [];

    const entryDate =
      node.rawTor?.ENTRYDATE || node.rawTor?.DeviceDate;

    if (
      entryDate &&
      !history.some(
        h =>
          (h.rawTor?.ENTRYDATE || h.rawTor?.DeviceDate) === entryDate
      )
    ) {
      history.unshift({
        timestamp: entryDate,
        rawTor: node.rawTor,
        metrics: node.metrics
      });
      if (history.length > 5000) history.pop();
    }

    vehicleStore[node.id] = {
      ...existing,
      ...node,
      history
    };
  });

  persistData();
  res.json({ success: true });
});

/* ================= USERS ================= */

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = userStore[username];
  if (user && String(user.password) === String(password)) {
    res.json({ success: true, user });
  } else {
    res.status(401).json({ success: false });
  }
});

/* ================= START ================= */

/* ✅ REQUIRED FOR RENDER */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 OSME Backend running on port ${PORT}`);
});
