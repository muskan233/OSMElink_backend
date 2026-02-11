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
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true
}));

app.use(express.json({ limit: '100mb' }));

// Serve static files (no favicon crash)
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

const fetchAllPages = async (endpoint, payload = {}) => {
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

      const list = Array.isArray(res.data)
        ? res.data
        : Array.isArray(res.data?.data)
        ? res.data.data
        : Array.isArray(res.data?.result)
        ? res.data.result
        : [];

      if (!list.length) break;

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

const deriveVehicleStatus = (v) => {
  const deviceTime = new Date(v.DeviceDate);
  if (isNaN(deviceTime.getTime())) return 'Offline';

  const diffMin = (Date.now() - deviceTime.getTime()) / 60000;

  // 24 hours = Non Communicating
  if (diffMin > 1440) return 'Non-Communicating';

  // 15 mins = Offline
  if (diffMin > 15) return 'Offline';

  if (v.MachineStatus === 'On') return 'Online';

  if (v.isCharging === true || Number(v.BatteryChargingIndication1) > 0)
    return 'Charging';

  if (Number(v.Speed) > 0) return 'Running';

  if (v.KeyOnSignal === '1') return 'Idle';

  return 'Off';
};


/* ---------------- TOR → VEHICLE SYNC ---------------- */
const syncFleetFromTOR = async () => {
  try {
    if (!authToken && !(await getTorToken())) {
      console.error('❌ TOR token missing, cannot sync fleet');
      return;
    }

    console.log('🔄 TOR sync started');

    const payload = { hardwareId: "", equipmentCode: "" };
    const metaList = await fetchAllPages('/EquipDetails/GetVehicleDetails', payload);
    const telemetryList = await fetchAllPages('/MachineData/GetLatestMachineData', payload);

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
        status: deriveVehicleStatus(v),
        lat: Number(getVal(v, ['Latitude'], 0)),
        lng: Number(getVal(v, ['Longitude'], 0)),
        speed: Number(getVal(v, ['Speed'], 0)),
        battery: Number(getVal(v, ['StateofCharge'], 0)),
        odometer: Number(getVal(v, ['Odometer'], 0)),
        rssi: Number(getVal(v, ['RSSI'], 0)),
        isCharging: v.isCharging === true,
        immobilized: v.Immobilization_status === "1",
        lastUpdate: new Date(v.DeviceDate || Date.now())
      };

      try {
      await db.execute(
      `INSERT INTO vehicle_rawdata
      (HWID, ENTRYDATE, DeviceDate, ModelNumber, Latitude, Longitude,
      StateofCharge, TimetoCharge, DistancetoEmpty1, KeyOnSignal,
      BattTemp, BatteryVoltage, BatteryChargingIndication1,
      Odometer, Speed, RSSI, MachineStatus, Immobilization_status, ControllerTemperature)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
          v.HWID,
        v.ENTRYDATE,
        v.DeviceDate,
        v.ModelNumber,
        v.Latitude,
        v.Longitude,
        v.StateofCharge,
        v.TimetoCharge,
        v.DistancetoEmpty1,
        v.KeyOnSignal,
        v.BattTemp,
        v.BatteryVoltage,
        v.BatteryChargingIndication1,
        v.Odometer,
        v.Speed,
        v.RSSI,
        v.MachineStatus,
        v.Immobilization_status,
        v.ControllerTemperature
      ]
    );
  } catch (e) {
    console.error("Rawdata insert failed:", e.message);
  }

    }

    console.log(`✅ TOR sync complete (${telemetryList.length} vehicles)`);
  } catch (err) {
    console.error('❌ TOR sync error:', err.message);
    authToken = null;
  }
};

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
    const [rows] = await db.query(`
      SELECT 
        vehicleId,
        displayDeviceId,
        registrationNo,
        status,
        lat,
        lng,
        speed,
        battery,
        odometer,
        lastUpdate
      FROM vehicles
    `);

    const formatted = rows.map(v => ({
  id: v.vehicleId,
  vehicleId: v.vehicleId,

  displayDeviceId: v.displayDeviceId,
  registrationNo: v.registrationNo,
  status: v.status,

  equipmentConfig: {
    active: v.status !== 'Offline',
  },

  location: {
    lat: Number(v.lat) || 0,
    lng: Number(v.lng) || 0
  },

  metrics: {
    speed: Number(v.speed) || 0,
    batteryLevel: Number(v.battery) || 0,
    totalKm: Number(v.odometer) || 0,
    rssi: Number(v.rssi) || 0,
    isCharging: v.isCharging === 1,
    immobilized: v.immobilized === 1
  },

  lastUpdate: v.lastUpdate
}));


    res.json(formatted);
  } catch (e) {
    console.error('❌ /api/vehicles error:', e.message);
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

/* ---------------- CUSTOMERS API ---------------- */

// GET all customers
app.get('/api/customers', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT 
        id,
        customerName,
        phoneNo,
        emailId,
        address,
        city,
        state,
        isUser,
        username
      FROM customers
      ORDER BY customerName
    `);

    res.json(rows);
  } catch (e) {
    console.error('❌ /api/customers error:', e.message);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

// CREATE or UPDATE customer
app.post('/api/customers', async (req, res) => {
  try {
    const {
      id,
      customerName,
      phoneNo,
      emailId,
      address,
      city,
      state,
      isUser,
      username,
      password,
      role
    } = req.body;

    if (!customerName || !phoneNo) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (id) {
      // UPDATE
      await db.execute(
        `UPDATE customers SET
          customerName=?,
          phoneNo=?,
          emailId=?,
          address=?,
          city=?,
          state=?,
          isUser=?,
          username=?,
          password=COALESCE(?, password),
          role=?
        WHERE id=?`,
        [
          customerName,
          phoneNo,
          emailId,
          address,
          city,
          state,
          isUser ? 1 : 0,
          username,
          password || null,
          role || null,
          id
        ]
      );
    } else {
      // INSERT
      await db.execute(
        `INSERT INTO customers
          (customerName, phoneNo, emailId, address, city, state, isUser, username, password, role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          customerName,
          phoneNo,
          emailId,
          address,
          city,
          state,
          isUser ? 1 : 0,
          username,
          password || null,
          role || null
        ]
      );
    }

    res.json({ success: true });
  } catch (e) {
    console.error('❌ /api/customers save error:', e.message);
    res.status(500).json({ error: 'Failed to save customer' });
  }
});

/* ---------------- DEALERS API ---------------- */
app.get('/api/dealers', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT id, dealerName
      FROM dealers
      ORDER BY dealerName
    `);

    res.json(rows);
  } catch (e) {
    console.error('❌ /api/dealers error:', e.message);
    res.status(500).json({ error: 'Failed to fetch dealers' });
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

/* ---------------- DEBUG ROUTE ---------------- */
app.get('/debug-tor', async (req, res) => {
  if (!authToken && !(await getTorToken())) return res.status(500).json({ error: 'TOR token missing' });

  try {
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
      metaRaw: meta.data,
      telemetryRaw: telemetry.data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/report', async (req, res) => {
  try {
    const { vehicleId, from, to } = req.query;

    let query = `
      SELECT *
      FROM vehicle_rawdata
      WHERE HWID = ?
    `;
    const params = [vehicleId];

    if (from && to) {
      query += ` AND DeviceDate BETWEEN ? AND ?`;
      params.push(new Date(from), new Date(to));
    }

    query += ` ORDER BY DeviceDate DESC LIMIT 5000`;

    const [rows] = await db.query(query, params);
    res.json(rows);

  } catch (e) {
    console.error("Report API error:", e.message);
    res.status(500).json({ error: 'Failed to fetch report' });
  }
});


/* ---------------- START ---------------- */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend running on ${PORT}`);
});
