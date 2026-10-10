import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8787;

// Security middleware
app.use(helmet());
app.use(express.json({ limit: '100kb' }));

// CORS configuration for dashboard integration
const allowedOrigins = (process.env.DASHBOARD_ORIGINS || 'http://localhost:5500')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      return callback(null, true);
    }
    return callback(new Error('Origin not allowed by CORS'));
  },
  credentials: true
}));

// Rate limiting: allow up to 120 reports per minute per IP
const reportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Too many reports from this IP, please slow down.' }
});

// Parse token mapping from AGENT_TOKENS_JSON
let agentTokens = {};
try {
  if (process.env.AGENT_TOKENS_JSON) {
    agentTokens = JSON.parse(process.env.AGENT_TOKENS_JSON);
  }
} catch (err) {
  console.error('Failed to parse AGENT_TOKENS_JSON:', err.message);
}

// Initialize Firebase Admin SDK
let db = null;
try {
  if (getApps().length === 0) {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      initializeApp({
        credential: cert(process.env.GOOGLE_APPLICATION_CREDENTIALS)
      });
      db = getFirestore();
      console.log('Firebase Admin SDK initialized successfully.');
    } else {
      console.warn('GOOGLE_APPLICATION_CREDENTIALS not provided. Running in simulation mode (reports logged to console).');
    }
  } else {
    db = getFirestore();
  }
} catch (err) {
  console.warn('Firebase Admin SDK initialization skipped:', err.message);
}

// Liveness probe
app.get('/healthz', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    firestoreConnected: Boolean(db),
    registeredTokenCount: Object.keys(agentTokens).length
  });
});

// Bearer Token Authentication Middleware
function authenticateAgent(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized_agent', message: 'Missing or malformed Authorization header' });
  }

  const token = authHeader.split(' ')[1].trim();
  const systemId = req.body?.systemId?.toUpperCase();

  if (!systemId) {
    return res.status(400).json({ error: 'invalid_payload', message: 'Payload must contain systemId' });
  }

  const expectedToken = agentTokens[systemId];
  if (!expectedToken || expectedToken !== token) {
    return res.status(401).json({ error: 'unauthorized_agent', message: 'Invalid token for system ID' });
  }

  next();
}

// Report endpoint
const handleReport = async (req, res) => {
  try {
    const {
      systemId,
      hostname,
      agentVersion = '1.0.0',
      agentStatus = 'online',
      hardware = {},
      examSoftware = [],
      alerts = []
    } = req.body;

    const normalizedId = systemId.toUpperCase();

    // Bounds and validation checks
    const cpu = Number(hardware.cpuPercent);
    const mem = Number(hardware.memoryPercent);
    const diskGb = Number(hardware.diskFreeGb);
    const diskPct = Number(hardware.diskFreePercent);

    const safeHardware = {
      cpuPercent: isNaN(cpu) ? 0 : Math.min(100, Math.max(0, cpu)),
      memoryPercent: isNaN(mem) ? 0 : Math.min(100, Math.max(0, mem)),
      diskFreeGb: isNaN(diskGb) ? 0 : Math.max(0, diskGb),
      diskFreePercent: isNaN(diskPct) ? 0 : Math.min(100, Math.max(0, diskPct))
    };

    const safeStatus = ['online', 'needs_attention'].includes(agentStatus) ? agentStatus : 'online';

    // If Firestore is available, enforce registration and persistence
    if (db) {
      // 1. Verify system is registered in systems/{systemId}
      const sysDoc = await db.collection('systems').doc(normalizedId).get();
      if (!sysDoc.exists) {
        return res.status(409).json({
          error: 'system_not_registered',
          message: `System ${normalizedId} must be registered in CampusLab dashboard before reporting telemetry.`
        });
      }
      if (sysDoc.data().monitoringEnabled === false) {
        return res.status(200).json({
          success: true,
          monitored: false,
          systemId: normalizedId,
          status: 'monitoring_disabled'
        });
      }

      const monitorRef = db.collection('monitoring').doc(normalizedId);
      const prevDoc = await monitorRef.get();
      const prevData = prevDoc.exists ? prevDoc.data() : null;
      const safeAlerts = Array.isArray(alerts) ? alerts : [];
      const previousAlerts = Array.isArray(prevData?.alerts) ? prevData.alerts : [];
      const needsAttention = safeStatus === 'needs_attention' || safeAlerts.length > 0;
      const recovered = Boolean(prevData) &&
        (prevData.agentStatus === 'needs_attention' || previousAlerts.length > 0) &&
        safeStatus === 'online' && safeAlerts.length === 0;
      const problemStartedAt = needsAttention
        ? (prevData?.problemStartedAt || FieldValue.serverTimestamp())
        : null;

      // 2. Check if a transition event should be recorded
      const hasChangedStatus = !prevData || prevData.agentStatus !== safeStatus;
      const prevAlertsStr = (prevData?.alerts || []).slice().sort().join(',');
      const currAlertsStr = safeAlerts.slice().sort().join(',');
      const hasChangedAlerts = prevAlertsStr !== currAlertsStr;

      if (!prevData) {
        // First seen event
        await db.collection('monitoringEvents').add({
          systemId: normalizedId,
          type: 'first_seen',
          previousStatus: null,
          status: safeStatus,
          alerts: safeAlerts,
          hostname: hostname || normalizedId,
          createdAt: FieldValue.serverTimestamp()
        });
      } else if (hasChangedStatus || hasChangedAlerts) {
        // Health / alert set transition event
        await db.collection('monitoringEvents').add({
          systemId: normalizedId,
          type: 'health_change',
          previousStatus: prevData.agentStatus || 'online',
          status: safeStatus,
          alerts: safeAlerts,
          hostname: hostname || normalizedId,
          createdAt: FieldValue.serverTimestamp()
        });
      }

      if (needsAttention || recovered) {
        const openFaults = await db.collection('faultReports')
          .where('systemId', '==', normalizedId)
          .get();
        const batch = db.batch();
        let updatedFaultCount = 0;

        openFaults.docs.forEach((faultDoc) => {
          const fault = faultDoc.data();
          const nextStatus = needsAttention && fault.status === 'open'
            ? 'in_progress'
            : recovered && fault.status === 'in_progress'
              ? 'resolved'
              : null;

          if (nextStatus) {
            batch.update(faultDoc.ref, {
              status: nextStatus,
              updatedAt: FieldValue.serverTimestamp()
            });
            updatedFaultCount += 1;
          }
        });

        if (updatedFaultCount > 0) await batch.commit();
      }

      // 3. Update the monitoring snapshot
      await monitorRef.set({
        systemId: normalizedId,
        hostname: hostname || normalizedId,
        agentVersion,
        agentStatus: safeStatus,
        problemStartedAt,
        lastHeartbeatAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        hardware: safeHardware,
        examSoftware: Array.isArray(examSoftware) ? examSoftware : [],
        alerts: safeAlerts
      }, { merge: true });
    } else {
      console.log(`[SIMULATION REPORT] ${normalizedId}: Status=${safeStatus}, CPU=${safeHardware.cpuPercent}%, RAM=${safeHardware.memoryPercent}%, Disk=${safeHardware.diskFreeGb}GB, Alerts=${alerts.join(';')}`);
    }

    return res.status(200).json({
      success: true,
      systemId: normalizedId,
      status: safeStatus,
      recordedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error processing telemetry report:', error);
    return res.status(500).json({
      error: 'internal_server_error',
      message: 'Failed to process monitoring report'
    });
  }
};

app.post('/api/v1/monitoring/report', reportLimiter, authenticateAgent, handleReport);
app.post('/api/monitoring/report', reportLimiter, authenticateAgent, handleReport);

app.listen(PORT, () => {
  console.log(`CampusLab Monitoring API listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/healthz`);
});
