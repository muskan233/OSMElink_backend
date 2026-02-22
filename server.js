import express from 'express';
import cors from 'cors';
import axios from 'axios';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import path from 'path';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
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
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
}));

app.options('*', cors()); 

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

    const rawRows = [];
    const currentRows = [];

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
        lastUpdate: new Date(v.DeviceDate || Date.now())
      };

      rawRows.push([
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
      ]);

      currentRows.push([
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
      ]);
    }

    // HISTORY INSERT
    if (rawRows.length) {
      await db.query(
        `INSERT INTO vehicle_rawdata
        (HWID, ENTRYDATE, DeviceDate, ModelNumber, Latitude, Longitude,
        StateofCharge, TimetoCharge, DistancetoEmpty1, KeyOnSignal,
        BattTemp, BatteryVoltage, BatteryChargingIndication1,
        Odometer, Speed, RSSI, MachineStatus, Immobilization_status, ControllerTemperature)
        VALUES ?`,
        [rawRows]
      );
    }

    // CURRENT UPSERT
    if (currentRows.length) {
      await db.query(
        `INSERT INTO vehicle_current
         (vehicleId, displayDeviceId, registrationNo, status, lat, lng, speed, battery, odometer, lastUpdate)
         VALUES ?
         ON DUPLICATE KEY UPDATE
         displayDeviceId = VALUES(displayDeviceId),
         registrationNo = VALUES(registrationNo),
         status = VALUES(status),
         lat = VALUES(lat),
         lng = VALUES(lng),
         speed = VALUES(speed),
         battery = VALUES(battery),
         odometer = VALUES(odometer),
         lastUpdate = VALUES(lastUpdate)`,
        [currentRows]
      );
    }

    console.log('✅ TOR sync completed');

  } catch (e) {
    console.error('❌ TOR sync failed:', e.message);
  }
};


let isSyncing = false;

setInterval(async () => {
  if (isSyncing) {
    console.log("⏳ Previous sync still running...");
    return;
  }

  try {
    isSyncing = true;
    await syncFleetFromTOR();
  } finally {
    isSyncing = false;
  }
}, 60000); 


app.get('/api/telemetry/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const [rows] = await db.query(
      `SELECT * FROM vehicle_rawdata WHERE HWID=? ORDER BY DeviceDate DESC LIMIT 1`,
      [id]
    );

    if (!rows.length) return res.status(404).json({ error: 'No telemetry found' });

    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Telemetry fetch failed' });
  }
});

app.post('/api/telemetry/:id/sync-history', async (req, res) => {
  try {
    const { id } = req.params;
    const { from, to } = req.body;

    if (!authToken && !(await getTorToken()))
      return res.status(500).json({ error: 'TOR token missing' });

    const history = await fetchAllPages(
      '/MachineData/GetMachineHistoryData',
      {
        hardwareId: id,
        fromDate: from,
        toDate: to
      }
    );

    if (!history.length)
      return res.json({ success: true, inserted: 0 });

    const rows = history.map(v => [
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
    ]);

    await db.query(
      `INSERT INTO vehicle_rawdata
       (HWID, ENTRYDATE, DeviceDate, ModelNumber, Latitude, Longitude,
        StateofCharge, TimetoCharge, DistancetoEmpty1, KeyOnSignal,
        BattTemp, BatteryVoltage, BatteryChargingIndication1,
        Odometer, Speed, RSSI, MachineStatus, Immobilization_status, ControllerTemperature)
       VALUES ?`,
      [rows]
    );

    res.json({ success: true, inserted: rows.length });

  } catch (e) {
    console.error('History sync failed:', e.message);
    res.status(500).json({ error: 'History sync failed' });
  }
});

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

const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token)
    return res.status(401).json({ message: "No token provided" });

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err)
      return res.status(403).json({ message: "Invalid token" });

    req.user = decoded;
    next();
  });
};

/* ---------------- API ---------------- */
app.get('/api/vehicles', verifyToken, async (req, res) => {
  try {
    const { role, customerId, dealerId } = req.user;

    let query = `
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
      FROM vehicle_current
    `;

    const params = [];

    //filtering based on role
    if (role === 'customer') {
      query += ` WHERE customerId = ?`;
      params.push(customerId);
    } 
    else if (role === 'dealer') {
      query += ` WHERE dealerId = ?`;
      params.push(dealerId);
    }
  
  const [rows] = await db.query(query, params);

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
    const [rows] = await db.query(
      'SELECT * FROM users WHERE username = ?',
      [username]
    );

    if (!rows.length)
      return res.status(401).json({ message: "Invalid credentials" });

    const user = rows[0];

    const match = await bcrypt.compare(password, user.password);
    if (!match)
      return res.status(401).json({ message: "Invalid credentials" });

    const token = jwt.sign(
      {
        id: user.id,
        role: user.role,
        customerId: user.customerId,
        dealerId: user.dealerId
      },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({
      success: true,
      token,
      user:{
        id: user.id,
        username: user.username,
        role: user.role,
        customerId: user.customerId,
        dealerId: user.dealerId
      }
    });

  } catch (e) {
    console.error("Login error:", e.message);
    res.status(500).json({ error: "Login failed" });
  }
});

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
        state
      FROM customers
      ORDER BY id DESC
    `);

    res.json(rows);

  } catch (e) {
    console.error('Fetch customers error:', e);
    res.status(500).json({ error: 'Failed to fetch customers' });
  }
});

app.post('/api/customers', async (req, res) => {
  try {
    const {
      customerName,
      phoneNo,
      emailId,
      address,
      city,
      state,
      isUser,
      username,
      password
    } = req.body;

    if (!customerName || !phoneNo) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // 1️⃣ Insert into customers table
    const [result] = await db.execute(
      `INSERT INTO customers
        (customerName, phoneNo, emailId, address, city, state)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [customerName, phoneNo, emailId, address, city, state]
    );

    const customerId = result.insertId;

    if (isUser && username && password) {
      const hashedPassword = await bcrypt.hash(password, 10);

      await db.execute(
        `INSERT INTO users
          (username, password, role, customerId)
         VALUES (?, ?, 'customer', ?)`,
        [username, hashedPassword, customerId]
      );
    }

    res.json({ success: true });

  } catch (e) {
    console.error('Customer save error:', e);
    res.status(500).json({ error: 'Failed to save customer' });
  }
});


/* ---------------- DEALERS API ---------------- */
app.get('/api/dealers', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT 
        id,
        dealerName,
        dealerCode,
        contactPerson,
        contactNumber,
        email,
        address,
        city,
        state,
        createdAt
      FROM dealers
      ORDER BY id DESC
    `);

    res.json(rows);

  } catch (e) {
    console.error('Fetch dealers error:', e);
    res.status(500).json({ error: 'Failed to fetch dealers' });
  }
});

app.post('/api/dealers', async (req, res) => {
  try {
    const {
      dealerName,
      dealerCode,
      contactPerson,
      contactNumber,
      email,
      address,
      city,
      state,
      createLogin,
      username,
      password
    } = req.body;

    if (!dealerName) {
      return res.status(400).json({ error: "Dealer name is required" });
    }

    // 1️⃣ Insert dealer business data
    const [result] = await db.execute(
      `INSERT INTO dealers
       (dealerName, dealerCode, contactPerson, contactNumber, email, address, city, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        dealerName,
        dealerCode,
        contactPerson,
        contactNumber,
        email,
        address,
        city,
        state
      ]
    );

    const dealerId = result.insertId;

    // 2️⃣ Create login in users table (if required)
    if (createLogin && username && password) {

      // Check duplicate username
      const [existing] = await db.query(
        "SELECT id FROM users WHERE username = ?",
        [username]
      );

      if (existing.length > 0) {
        return res.status(400).json({ error: "Username already exists" });
      }

      const hashedPassword = await bcrypt.hash(password, 10);

      await db.execute(
        `INSERT INTO users
         (username, password, role, dealerId)
         VALUES (?, ?, 'dealer', ?)`,
        [username, hashedPassword, dealerId]
      );
    }

    res.json({ success: true });

  } catch (e) {
    console.error("Dealer save error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/vehicles/:id', async (req, res) => {
  const { id } = req.params;

  const {
    displayDeviceId,
    chassisNumber,
    registrationNo,
    customerId,
    dealerId,
    invoiceDate
  } = req.body;

  try {
    await db.execute(
      `UPDATE vehicles
       SET displayDeviceId = ?,
           registrationNo = ?,
           chassis_no = ?,
           customerId = ?,
           dealerId = ?,
           invoiceDate = ?
       WHERE vehicleId = ?`,
      [
        displayDeviceId,
        registrationNo,
        chassisNumber,
        customerId,
        dealerId,
        invoiceDate,
        id
      ]
    );

    res.json({ success: true });

  } catch (err) {
    console.error('Vehicle update error:', err);
    res.status(500).json({ error: 'Update failed' });
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
      params.push(from,to);
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
