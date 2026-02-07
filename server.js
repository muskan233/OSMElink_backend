import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { fileURLToPath } from 'url';

/* ---------------- SETUP ---------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;
const DB_FILE = path.join(__dirname, 'fleet_db.json');

const TOR_BASE_URL = 'https://torapis.tor-iot.com';
const TOR_USER = process.env.TOR_USER;
const TOR_PASS = process.env.TOR_PASS;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '100mb' }));

/* ---------------- STORES ---------------- */
let vehicleStore = {};
let userStore = {
  admin: {
    username: 'admin',
    password: 'Osme@2025',
    role: 'Admin',
    isActive: true
  }
};

/* ---------------- DB ---------------- */
const loadDatabase = () => {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      vehicleStore = data.vehicles || {};
      userStore = { ...userStore, ...(data.users || {}) };
    }
  } catch (e) {
    console.error('❌ DB load failed:', e.message);
  }
};

const persistData = () => {
  try {
    fs.writeFileSync(
      DB_FILE,
      JSON.stringify({ vehicles: vehicleStore, users: userStore }, null, 2)
    );
  } catch (e) {
    console.error('❌ DB save failed:', e.message);
  }
};

loadDatabase();

/* ---------------- TOR AUTH ---------------- */
let authToken = null;

const getTorToken = async () => {
  try {
    const res = await axios.post(
      `${TOR_BASE_URL}/Auth/login`,
      { username: TOR_USER, password: TOR_PASS },
      { timeout: 15000 }
    );

    authToken =
      res.data?.token ||
      res.data?.data?.token ||
      res.data?.result?.token;

    return authToken;
  } catch (e) {
    console.error('❌ TOR auth failed:', e.message);
    authToken = null;
    return null;
  }
};

/* ---------------- HELPERS ---------------- */
const getVal = (obj, keys, fallback = null) => {
  for (const k of keys) {
    if (obj?.[k] !== undefined && obj?.[k] !== null) return obj[k];
  }
  return fallback;
};

const fetchAllPages = async (endpoint, payload) => {
  let all = [];
  let pageNo = 1;
  const pageSize = 1000;

  while (true) {
    const res = await axios.post(
      `${TOR_BASE_URL}${endpoint}`,
      { ...payload, pageNo, pageSize },
      { headers: { Authorization: `Bearer ${authToken}` }, timeout: 60000 }
    );

    const list = res.data?.data || res.data?.result || [];
    if (!Array.isArray(list) || list.length === 0) break;

    all.push(...list);
    if (list.length < pageSize) break;
    pageNo++;
  }

  return all;
};

/* ---------------- TOR → VEHICLE SYNC (PULL) ---------------- */
const syncFleetFromTOR = async () => {
  try {
    if (!authToken && !(await getTorToken())) return;

    console.log('🔄 TOR sync started');

    const metaList = await fetchAllPages(
      '/EquipDetails/GetVehicleDetails',
      { hardwareId: '', equipmentCode: '' }
    );

    const telemetryList = await fetchAllPages(
      '/MachineData/GetLatestMachineData',
      { hardwareId: '', equipmentCode: '' }
    );

    console.log(`META COUNT: ${metaList.length}`);
    console.log(`TELEMETRY COUNT: ${telemetryList.length}`);

    const metaMap = new Map();
    metaList.forEach(m => {
      const hwid = String(getVal(m, ['HWID', 'hardwareId'], '')).trim();
      if (hwid) metaMap.set(hwid, m);
    });

    telemetryList.forEach(v => {
      const hwid = String(getVal(v, ['HWID', 'hardwareId'], '')).trim();
      if (!hwid) return;

      const meta = metaMap.get(hwid) || {};
      const existing = vehicleStore[hwid] || {};

      vehicleStore[hwid] = {
        ...existing,
        vehicleId: hwid,
        displayDeviceId: getVal(meta, ['equipmentCode'], hwid),
        registrationNo: getVal(meta, ['vehicleRegNo'], '---'),
        status: getVal(v, ['MachineStatus'], 'Off'),
        location: {
          lat: Number(getVal(v, ['Latitude'], 0)),
          lng: Number(getVal(v, ['Longitude'], 0))
        },
        metrics: {
          speed: Number(getVal(v, ['Speed'], 0)),
          battery: Number(getVal(v, ['StateofCharge'], 0)),
          odometer: Number(getVal(v, ['Odometer'], 0))
        },
        lastUpdate: new Date().toISOString()
      };
    });

    persistData();
    console.log(`✅ TOR sync complete (${Object.keys(vehicleStore).length} vehicles)`);
  } catch (err) {
    console.error('❌ TOR sync error:', err.message);
    authToken = null;
  }
};

setInterval(syncFleetFromTOR, 30000);
syncFleetFromTOR();

/* ---------------- 🔥 FORWARDER INGEST (PUSH) ---------------- */
app.post('/api/telemetry/bulk', (req, res) => {
  try {
    const list = req.body;

    if (!Array.isArray(list)) {
      return res.status(400).json({ error: 'Payload must be array' });
    }

    console.log(`📥 Forwarder received ${list.length} vehicles`);

    list.forEach(v => {
      if (!v.vehicleId) return;

      vehicleStore[v.vehicleId] = {
        ...vehicleStore[v.vehicleId],
        ...v,
        lastUpdate: new Date().toISOString()
      };
    });

    persistData();

    res.json({
      success: true,
      vehicles: Object.keys(vehicleStore).length
    });
  } catch (e) {
    console.error('❌ Bulk ingest failed:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------------- API ---------------- */
app.get('/api/vehicles', (req, res) => {
  res.json(Object.values(vehicleStore));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = userStore[username];
  if (user && user.password === password) {
    res.json({ success: true, user });
  } else {
    res.status(401).json({ success: false });
  }
});

/* ---------------- START ---------------- */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend running on ${PORT}`);
});
