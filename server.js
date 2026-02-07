import express from 'express';
import cors from 'cors';
import axios from 'axios';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

/* ---------------- SETUP ---------------- */
const app = express();
const PORT = process.env.PORT || 5000;

// CORS setup
app.use(cors({
  origin: [
    'http://localhost:5173',              // local dev
    'https://osmelink-frontend.onrender.com', // production frontend
    'https://blue-seal-873817.hostingersite.com'
  ]
}));
app.use(express.json({ limit: '100mb' }));

/* ---------------- MYSQL CONNECTION ---------------- */
const db = await mysql.createPool({
  host: process.env.DB_HOST,     // e.g., srv2197.hstgr.io
  user: process.env.DB_USER,     // your MySQL user
  password: process.env.DB_PASS, // your MySQL password
  database: process.env.DB_NAME, // your database name
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

/* ---------------- TOR AUTH ---------------- */
const getTorToken = async () => {
  try {
    const res = await axios.post(
      `${TOR_BASE_URL}/Auth/login`,
      { username: TOR_USER, password: TOR_PASS },
      { timeout: 15000 }
    );

    authToken = res.data?.token || res.data?.data?.token || res.data?.result?.token;
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
    if (!authToken && !(await getTorToken())) return;

    console.log('🔄 TOR sync started');

    // Fetch metadata
    const metaList = await fetchAllPages('/EquipDetails/GetVehicleDetails', { hardwareId: '', equipmentCode: '' });
    const telemetryList = await fetchAllPages('/MachineData/GetLatestMachineData', { hardwareId: '', equipmentCode: '' });

    console.log(`META COUNT: ${metaList.length}`);
    console.log(`TELEMETRY COUNT: ${telemetryList.length}`);

    const metaMap = new Map();
    metaList.forEach(m => {
      const hwid = String(getVal(m, ['HWID', 'hardwareId'], '')).trim();
      if (hwid) metaMap.set(hwid, m);
    });

    for (const v of telemetryList) {
      const hwid = String(getVal(v, ['HWID', 'hardwareId'], '')).trim();
      if (!hwid) continue;

      const meta = metaMap.get(hwid) || {};

      const vehicleData = {
        vehicleId: hwid,
        displayDeviceId: getVal(meta, ['equipmentCode'], hwid),
        registrationNo: getVal(meta, ['vehicleRegNo'], '---'),
        status: getVal(v, ['MachineStatus'], 'Off'),
        lat: Number(getVal(v, ['Latitude'], 0)),
        lng: Number(getVal(v, ['Longitude'], 0)),
        speed: Number(getVal(v, ['Speed'], 0)),
        battery: Number(getVal(v, ['StateofCharge'], 0)),
        odometer: Number(getVal(v, ['Odometer'], 0)),
        lastUpdate: new Date()
      };

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
    }

    console.log(`✅ TOR sync complete (${telemetryList.length} vehicles)`);

  } catch (err) {
    console.error('❌ TOR sync error:', err.message);
    authToken = null;
  }
};

setInterval(syncFleetFromTOR, 30000); // every 30 sec
syncFleetFromTOR();

/* ---------------- FORWARDER INGEST (PUSH) ---------------- */
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

/* ---------------- START ---------------- */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend running on ${PORT}`);
});
