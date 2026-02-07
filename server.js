import express from 'express';
import cors from 'cors';
import axios from 'axios';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

/* ---------------- SETUP ---------------- */
const app = express();
const PORT = process.env.PORT || 5000;
// CORS setup
app.use(cors({
  origin: [
    'http://localhost:5173',
    'https://osmelink-frontend.onrender.com',
    'https://blue-seal-873817.hostingersite.com'
  ]
}));

app.use(express.json({ limit: '100mb' }));

// Serve static files (fix 404 for favicon, etc.)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- MYSQL CONNECTION ---------------- */
const db = await mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

/* ---------------- TOR CONFIG ---------------- */
const TOR_BASE_URL = 'https://torapis.tor-iot.com';
const TOR_USER = process.env.TOR_USER;
const TOR_PASS = process.env.TOR_PASS;

let authToken = null;

/* ---------------- HELPERS ---------------- */
const getVal = (obj, keys, fallback = null) => {
  for (const k of keys) if (obj?.[k] !== undefined && obj?.[k] !== null) return obj[k];
  return fallback;
};

// Fetch all pages from TOR API with pagination
const fetchAllPages = async (endpoint, payload) => {
  let all = [];
  let pageNo = 1;
  const pageSize = 1000;

  while (true) {
    try {
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
    } catch (e) {
      console.error(`❌ Error fetching ${endpoint}:`, e.message);
      break;
    }
  }

  return all;
};

/* ---------------- TOR AUTH ---------------- */
const getTorToken = async () => {
  try {
    const res = await axios.post(
      `${TOR_BASE_URL}/Auth/login`,
      { username: TOR_USER, password: TOR_PASS },
      { timeout: 15000 }
    );

    authToken = res.data?.token || res.data?.data?.token || res.data?.result?.token;
    console.log('🔑 TOR token acquired');
    return authToken;
  } catch (e) {
    console.error('❌ TOR auth failed:', e.message);
    authToken = null;
    return null;
  }
};

/* ---------------- TOR → VEHICLE SYNC ---------------- */
const syncFleetFromTOR = async () => {
  try {
    // Ensure valid token
    if (!authToken && !(await getTorToken())) {
      console.error('❌ TOR token missing, cannot sync fleet');
      return;
    }

    console.log('🔄 TOR sync started');

    // Payload to fetch all vehicles
    const payload = { hardwareId: "", equipmentCode: "" };

    // Fetch vehicle meta and telemetry
    const metaList = await fetchAllPages('/EquipDetails/GetVehicleDetails', payload);
    const telemetryList = await fetchAllPages('/MachineData/GetLatestMachineData', payload);

    console.log(`META COUNT: ${metaList.length}`);
    console.log(`TELEMETRY COUNT: ${telemetryList.length}`);

    // Map hardwareId → meta for easy lookup
    const metaMap = new Map();
    metaList.forEach(m => {
      const hwid = String(getVal(m, ['HWID', 'hardwareId'], '')).trim();
      if (hwid) metaMap.set(hwid, m);
    });

    // Insert/update telemetry into MySQL
    for (const v of telemetryList) {
      const hwid = String(getVal(v, ['HWID', 'hardwareId'], '')).trim();
      if (!hwid) continue;

      const meta = metaMap.get(hwid) || {};
      const vehicleData = {
        vehicleId: hwid,
        displayDeviceId: getVal(meta, ['equipmentCode'], hwid),
        registrationNo: getVal(meta, ['vehicleRegNo'], '---'),
        status: getVal(v, ['MachineStatus'], 'Unknown'),
        lat: Number(getVal(v, ['Latitude'], 0)),
        lng: Number(getVal(v, ['Longitude'], 0)),
        speed: Number(getVal(v, ['Speed'], 0)),
        battery: Number(getVal(v, ['StateofCharge'], 0)),
        odometer: Number(getVal(v, ['Odometer'], 0)),
        lastUpdate: new Date()
      };

      try {
        await db.execute(
          `INSERT INTO vehicles
            (vehicleId, displayDeviceId, registrationNo, status, lat, lng, speed, battery, odometer, lastUpdate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             displayDeviceId=VALUES(displayDeviceId),
             registrationNo=VALUES(registrationNo),
             status=VALUES(status),
             lat=VALUES(lat),
             lng=VALUES(lng),
             speed=VALUES(speed),
             battery=VALUES(battery),
             odometer=VALUES(odometer),
             lastUpdate=VALUES(lastUpdate)`,
          [
            vehicleData.vehicleId,
            vehicleData.displayDeviceId,
            vehicleData.registrationNo,
            vehicleData.status,
            vehicleData.lat,
            vehicleData.lng,
            vehicleData.speed,
            vehicleData.battery,
            vehicleData.odometer,
            vehicleData.lastUpdate
          ]
        );
      } catch (dbErr) {
        console.error(`❌ DB insert failed for ${hwid}:`, dbErr.message);
      }
    }

    console.log(`✅ TOR sync complete (${telemetryList.length} vehicles)`);

  } catch (err) {
    console.error('❌ TOR sync error:', err.message);

    // Clear token so next sync refreshes it
    authToken = null;
  }
};

// Start sync every 30 sec
setInterval(syncFleetFromTOR, 30000);
syncFleetFromTOR();


/* ---------------- FORWARDER INGEST ---------------- */
app.post('/api/telemetry/bulk', async (req, res) => {
  try {
    const list = req.body;
    if (!Array.isArray(list)) return res.status(400).json({ error: 'Payload must be array' });

    console.log(`📥 Forwarder received ${list.length} vehicles`);

    for (const v of list) {
      if (!v.vehicleId) continue;

      await db.execute(
        `INSERT INTO vehicles
          (vehicleId, displayDeviceId, registrationNo, status, lat, lng, speed, battery, odometer, lastUpdate)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           displayDeviceId=VALUES(displayDeviceId),
           registrationNo=VALUES(registrationNo),
           status=VALUES(status),
           lat=VALUES(lat),
           lng=VALUES(lng),
           speed=VALUES(speed),
           battery=VALUES(battery),
           odometer=VALUES(odometer),
           lastUpdate=VALUES(lastUpdate)`,
        [
          v.vehicleId,
          v.displayDeviceId || v.vehicleId,
          v.registrationNo || '---',
          v.status || 'Off',
          v.location?.lat || 0,
          v.location?.lng || 0,
          v.metrics?.speed || 0,
          v.metrics?.battery || 0,
          v.metrics?.odometer || 0,
          new Date()
        ]
      );
    }

    const [rows] = await db.query('SELECT COUNT(*) as count FROM vehicles');
    res.json({ success: true, vehicles: rows[0].count });

  } catch (e) {
    console.error('❌ Bulk ingest failed:', e.message);
    res.status(500).json({ error: 'Server error' });
  }
});

/* ---------------- API ---------------- */
app.get('/api/vehicles', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM vehicles');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Database query failed' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const [rows] = await db.query('SELECT * FROM users WHERE username = ?', [username]);
    const user = rows[0];
    if (user && user.password === password) {
      res.json({ success: true, user });
    } else {
      res.status(401).json({ success: false });
    }
  } catch (e) {
    res.status(500).json({ error: 'Database query failed' });
  }
});

/* ---------------- TEST TOR AUTH ---------------- */
app.get('/test-tor-auth', async (req, res) => {
  try {
    const token = await getTorToken();
    res.json({ success: !!token, token });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

/* ---------------- DEBUG ROUTE TO CHECK DATA ---------------- */
app.get('/debug-tor', async (req, res) => {
  try {
    if (!authToken && !(await getTorToken())) return res.status(500).json({ error: 'TOR token missing' });

    const meta = await axios.post(
      `${TOR_BASE_URL}/EquipDetails/GetVehicleDetails`,
      {},
      { headers: { Authorization: `Bearer ${authToken}` } }
    );

    const telemetry = await axios.post(
      `${TOR_BASE_URL}/MachineData/GetLatestMachineData`,
      {},
      { headers: { Authorization: `Bearer ${authToken}` } }
    );

    res.json({
      metaCount: meta.data?.length || 0,
      telemetryCount: telemetry.data?.length || 0,
      metaSample: meta.data?.[0] || null,
      telemetrySample: telemetry.data?.[0] || null
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- START ---------------- */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend running on ${PORT}`);
});
