import { firebaseConfig, isConfigured } from './firebase-config.js';

// Firebase SDK imports from Google CDN
let app, auth, db;
let signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged;
let collection, doc, setDoc, addDoc, updateDoc, deleteDoc, onSnapshot, getDoc, serverTimestamp, query, orderBy, limit;

// State management
const ADMIN_EMAIL = 's.kamalesh284@gmail.com';
const MOCK_ACCOUNTS_KEY = 'campuslab.mockAccounts';

let currentUser = null;
let userProfile = { role: 'admin', displayName: 'Administrator' };
let systems = [];
let faultReports = [];
let monitoringData = {};
let useMock = !isConfigured;

function getRoleFromEmail(email) {
  if (!email) return 'admin';
  return 'admin';
}

function isAdminUser() {
  return getRoleFromEmail(currentUser?.email) === 'admin';
}

function getMockAccounts() {
  const storedAccounts = localStorage.getItem(MOCK_ACCOUNTS_KEY);
  if (!storedAccounts) return [];

  const accounts = JSON.parse(storedAccounts);
  if (!Array.isArray(accounts)) {
    throw new Error('Saved demo accounts could not be read.');
  }
  return accounts;
}

async function createPasswordVerifier(password, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );

  return {
    passwordSalt: Array.from(salt, byte => byte.toString(16).padStart(2, '0')).join(''),
    passwordHash: Array.from(new Uint8Array(derivedBits), byte => byte.toString(16).padStart(2, '0')).join('')
  };
}

async function verifyMockPassword(account, password) {
  if (!account.passwordSalt || !account.passwordHash) return false;

  const salt = Uint8Array.from(
    account.passwordSalt.match(/.{2}/g) || [],
    byte => Number.parseInt(byte, 16)
  );
  if (salt.length !== 16) return false;

  const verifier = await createPasswordVerifier(password, salt);
  if (verifier.passwordHash.length !== account.passwordHash.length) return false;

  let difference = 0;
  for (let index = 0; index < verifier.passwordHash.length; index += 1) {
    difference |= verifier.passwordHash.charCodeAt(index) ^ account.passwordHash.charCodeAt(index);
  }
  return difference === 0;
}

function applyRolePermissions() {
  const adminMode = isAdminUser();

  const systemNavItem = document.querySelector('.nav-item[data-page="systems"]');
  const examNavItem = document.querySelector('.nav-item[data-page="exam"]');
  const monitoringNavItem = document.querySelector('.nav-item[data-page="monitoring"]');
  if (systemNavItem) systemNavItem.style.display = adminMode ? '' : 'none';
  if (examNavItem) examNavItem.style.display = adminMode ? '' : 'none';
  if (monitoringNavItem) monitoringNavItem.style.display = adminMode ? '' : 'none';

  const showSystemFormBtn = document.getElementById('showSystemForm');
  if (showSystemFormBtn) {
    showSystemFormBtn.style.display = adminMode ? '' : 'none';
  }

  const showFaultFormBtn = document.getElementById('showFaultForm');
  if (showFaultFormBtn) {
    showFaultFormBtn.style.display = '';
  }

  const systemForm = document.getElementById('systemForm');
  if (systemForm) {
    systemForm.style.display = adminMode ? '' : 'none';
    if (!adminMode) systemForm.classList.add('hidden');
  }

  if (!adminMode) {
    navigateTo('faults');
  }
}

// UI Elements
const toastEl = document.getElementById('toast');
const loginView = document.getElementById('loginView');
const appView = document.getElementById('appView');
const loginForm = document.getElementById('loginForm');
const signupForm = document.getElementById('signupForm');
const loginError = document.getElementById('loginError');
const signupError = document.getElementById('signupError');
const authTitle = document.getElementById('authTitle');
const authSubtitle = document.getElementById('authSubtitle');
const authModeButtons = document.querySelectorAll('.auth-mode-btn');
const signOutBtn = document.getElementById('signOutBtn');
const navItems = document.querySelectorAll('.nav-item');
const pages = {
  overview: document.getElementById('overviewPage'),
  systems: document.getElementById('systemsPage'),
  faults: document.getElementById('faultsPage'),
  exam: document.getElementById('examPage'),
  monitoring: document.getElementById('monitoringPage')
};
const pageTitle = document.getElementById('pageTitle');
const currentSection = document.getElementById('currentSection');
const userEmailEl = document.getElementById('userEmail');
const userRoleEl = document.getElementById('userRole');
const avatarEl = document.getElementById('avatar');

// Helper: Toast Notifications
function showToast(message, type = 'success') {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.className = `toast show ${type === 'error' ? 'toast-error' : 'toast-success'}`;
  setTimeout(() => {
    toastEl.className = 'toast';
  }, 3500);
}

// Navigation
function navigateTo(pageKey) {
  Object.keys(pages).forEach(key => {
    if (pages[key]) {
      pages[key].classList.toggle('hidden', key !== pageKey);
    }
  });

  navItems.forEach(item => {
    item.classList.toggle('active', item.dataset.page === pageKey);
  });

  const titles = {
    overview: 'Lab overview',
    systems: 'Computer systems',
    faults: 'Fault reports',
    exam: 'Exam allocation',
    monitoring: 'Auto monitoring'
  };

  pageTitle.textContent = titles[pageKey] || 'Lab Operations';
  currentSection.textContent = pageKey.toUpperCase();
}

navItems.forEach(item => {
  item.addEventListener('click', () => {
    navigateTo(item.dataset.page);
  });
});

document.querySelectorAll('[data-goto]').forEach(btn => {
  btn.addEventListener('click', () => {
    navigateTo(btn.dataset.goto);
  });
});

// Helper: Date & Relative Time
function formatRelativeTime(date) {
  if (!date) return 'Never';
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (diffSec < 0) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

function formatDate(date) {
  if (!date) return '—';
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Systems Management
const showSystemFormBtn = document.getElementById('showSystemForm');
const hideSystemFormBtn = document.getElementById('hideSystemForm');
const systemForm = document.getElementById('systemForm');
const systemSearchInput = document.getElementById('systemSearch');
const systemsTable = document.getElementById('systemsTable');
const labTrackingList = document.getElementById('labTrackingList');

if (showSystemFormBtn) {
  showSystemFormBtn.addEventListener('click', () => systemForm.classList.remove('hidden'));
}
if (hideSystemFormBtn) {
  hideSystemFormBtn.addEventListener('click', () => systemForm.classList.add('hidden'));
}

if (systemForm) {
  systemForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const systemId = document.getElementById('systemId').value.trim().toUpperCase();
    const labName = document.getElementById('labName').value.trim();
    const status = document.getElementById('systemStatus').value;
    const reservedBy = document.getElementById('labReservedBy').value.trim();
    const notes = document.getElementById('systemNotes').value.trim();

    if (!systemId || !labName) return;

    try {
      if (useMock) {
        const existingIdx = systems.findIndex(s => s.systemId === systemId);
        const record = {
          systemId,
          labName,
          status,
          reservedBy,
          labStatus: reservedBy ? 'reserved' : 'free',
          notes,
          updatedAt: new Date(),
          updatedBy: currentUser?.email || 'admin@demo.local'
        };
        if (existingIdx >= 0) {
          systems[existingIdx] = { ...systems[existingIdx], ...record };
        } else {
          systems.push({ ...record, createdAt: new Date() });
        }
        renderSystems();
        renderOverview();
      } else {
        const ref = doc(db, 'systems', systemId);
        await setDoc(ref, {
          systemId,
          labName,
          status,
          notes,
          updatedAt: serverTimestamp(),
          updatedBy: currentUser?.uid || 'unknown'
        }, { merge: true });
      }

      showToast(`System ${systemId} saved successfully.`);
      systemForm.reset();
      systemForm.classList.add('hidden');
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Error saving system', 'error');
    }
  });
}

function renderSystems() {
  if (!systemsTable) return;
  const filter = (systemSearchInput?.value || '').toLowerCase().trim();
  const filtered = systems.filter(s => 
    s.systemId.toLowerCase().includes(filter) || 
    (s.labName && s.labName.toLowerCase().includes(filter))
  );

  if (filtered.length === 0) {
    systemsTable.innerHTML = `<tr><td colspan="6" class="empty">No systems found.</td></tr>`;
    return;
  }

  systemsTable.innerHTML = filtered.map(sys => {
    const updated = sys.updatedAt?.toDate ? sys.updatedAt.toDate() : (sys.updatedAt instanceof Date ? sys.updatedAt : null);
    return `
      <tr>
        <td><strong>${sys.systemId}</strong></td>
        <td>${sys.labName || '—'}</td>
        <td>${sys.notes || '<span class="muted">None</span>'}</td>
        <td><span class="badge ${sys.status}">${sys.status.replace('_', ' ')}</span></td>
        <td>${formatDate(updated)}</td>
        <td>
          <div class="action-btn-group">
            <button class="action-btn" type="button" disabled aria-label="System status is automated">AI managed</button>
            ${isAdminUser() ? `<button class="action-btn" type="button" data-remove-system="${sys.systemId}" aria-label="Remove ${sys.systemId}">Remove</button>` : ''}
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

if (systemsTable) {
  systemsTable.addEventListener('click', async (event) => {
    const removeButton = event.target.closest('[data-remove-system]');
    if (!removeButton || !isAdminUser()) return;

    const systemId = removeButton.dataset.removeSystem;
    if (!window.confirm(`Remove ${systemId} from the systems list? Existing fault reports will be kept.`)) return;

    try {
      if (useMock) {
        systems = systems.filter(system => system.systemId !== systemId);
        delete monitoringData[systemId];
      } else {
        await deleteDoc(doc(db, 'systems', systemId));
        systems = systems.filter(system => system.systemId !== systemId);
      }

      renderSystems();
      renderOverview();
      renderMonitoring();
      showToast(`System ${systemId} removed.`);
    } catch (err) {
      console.error(err);
      showToast(err.message || `Could not remove system ${systemId}.`, 'error');
    }
  });
}

window.changeSystemStatus = async (systemId, newStatus) => {
  showToast('System status is managed automatically and cannot be changed manually.', 'error');
  return;
};

if (systemSearchInput) {
  systemSearchInput.addEventListener('input', renderSystems);
}

// Fault Reports Management
const showFaultFormBtn = document.getElementById('showFaultForm');
const hideFaultFormBtn = document.getElementById('hideFaultForm');
const faultForm = document.getElementById('faultForm');
const faultFilter = document.getElementById('faultFilter');
const faultsTable = document.getElementById('faultsTable');

if (showFaultFormBtn) {
  showFaultFormBtn.addEventListener('click', () => faultForm.classList.remove('hidden'));
}
if (hideFaultFormBtn) {
  hideFaultFormBtn.addEventListener('click', () => faultForm.classList.add('hidden'));
}

if (faultForm) {
  faultForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const systemId = document.getElementById('faultSystem').value.trim().toUpperCase();
    const priority = document.getElementById('faultPriority').value;
    const description = document.getElementById('faultDescription').value.trim();

    if (!systemId || !description) return;

    try {
      if (useMock) {
        const mockFault = {
          id: 'mock-' + Date.now(),
          systemId,
          priority,
          description,
          status: 'open',
          reportedAt: new Date(),
          reportedBy: currentUser?.email || 'staff@demo.local'
        };
        faultReports.unshift(mockFault);
        renderFaults();
        renderOverview();
        scheduleMockFaultLifecycle(mockFault.id);
      } else {
        await addDoc(collection(db, 'faultReports'), {
          systemId,
          priority,
          description,
          status: 'open',
          reportedBy: currentUser?.uid || 'user',
          reportedByEmail: currentUser?.email || 'unknown',
          reportedAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      }

      showToast(`Fault report for ${systemId} submitted.`);
      faultForm.reset();
      faultForm.classList.add('hidden');
    } catch (err) {
      console.error(err);
      showToast(err.message || 'Error submitting fault', 'error');
    }
  });
}

function renderFaults() {
  if (!faultsTable) return;
  const filter = faultFilter?.value || 'all';
  const filtered = faultReports.filter(f => filter === 'all' || f.status === filter);

  if (filtered.length === 0) {
    faultsTable.innerHTML = `<tr><td colspan="6" class="empty">No fault reports match this filter.</td></tr>`;
    return;
  }

  faultsTable.innerHTML = filtered.map(f => {
    const reported = f.reportedAt?.toDate ? f.reportedAt.toDate() : (f.reportedAt instanceof Date ? f.reportedAt : null);
    return `
      <tr>
        <td><strong>${f.systemId}</strong></td>
        <td>${f.description}</td>
        <td><span class="badge ${f.priority}">${f.priority}</span></td>
        <td><span class="badge ${f.status}">${f.status.replace('_', ' ')}</span></td>
        <td>${formatRelativeTime(reported)}</td>
        <td>
          <div class="action-btn-group">
            <button class="action-btn" type="button" disabled aria-label="AI managed fault status">AI managed</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function scheduleMockFaultLifecycle(faultId) {
  setTimeout(() => {
    const fault = faultReports.find(item => item.id === faultId);
    if (!fault || fault.status !== 'open') return;
    fault.status = 'in_progress';
    fault.updatedAt = new Date();
    renderFaults();
    renderOverview();
  }, 3000);

  setTimeout(() => {
    const fault = faultReports.find(item => item.id === faultId);
    if (!fault || fault.status !== 'in_progress') return;
    fault.status = 'resolved';
    fault.updatedAt = new Date();
    renderFaults();
    renderOverview();
  }, 15000);
}

if (faultFilter) {
  faultFilter.addEventListener('change', renderFaults);
}

// Exam Allocation Management
let examAllocations = [
  { id: 'exam-1', examName: 'DBMS Midterm', students: 24, date: '2026-10-12', time: '10:00', labName: 'Computer Lab 1' },
  { id: 'exam-2', examName: 'CAD Studio Exam', students: 16, date: '2026-10-12', time: '14:00', labName: 'CAD Lab 2' }
];

const examAllocationForm = document.getElementById('examAllocationForm');
const examAllocationResult = document.getElementById('examAllocationResult');
const examAllocationTable = document.getElementById('examAllocationTable');

function getLabAvailabilitySnapshot() {
  const labs = new Map();

  systems.forEach(system => {
    const labName = system.labName || 'Unassigned lab';
    const lab = labs.get(labName) || { labName, working: 0, total: 0 };
    lab.total += 1;
    if (system.status === 'working') lab.working += 1;
    labs.set(labName, lab);
  });

  return Array.from(labs.values());
}

function autoAllocateExamLab(examName, studentCount, examDate, examTime) {
  const labSnapshots = getLabAvailabilitySnapshot().map(lab => {
    const usedBySlot = examAllocations
      .filter(item => item.date === examDate && item.time === examTime && item.labName === lab.labName)
      .reduce((sum, item) => sum + Number(item.students || 0), 0);

    const availableSeats = Math.max(0, Number(lab.working || 0) - usedBySlot);

    return {
      labName: lab.labName,
      availableSeats,
      totalSeats: lab.working || 0,
      usedBySlot,
      leftover: availableSeats - studentCount
    };
  });

  const exactFits = labSnapshots.filter(lab => lab.availableSeats >= studentCount);
  if (exactFits.length) {
    exactFits.sort((a, b) => {
      const diffA = Math.abs(a.availableSeats - studentCount);
      const diffB = Math.abs(b.availableSeats - studentCount);
      if (diffA !== diffB) return diffA - diffB;
      return b.availableSeats - a.availableSeats;
    });

    const chosen = exactFits[0];
    const slotKey = `${examDate}T${examTime}`;

    examAllocations.push({
      id: `exam-${Date.now()}`,
      examName,
      students: Number(studentCount),
      date: examDate,
      time: examTime,
      slotKey,
      labName: chosen.labName
    });

    renderExamAllocations();
    return {
      success: true,
      message: `${examName} has been allocated to ${chosen.labName} for ${studentCount} students at ${examTime} on ${examDate}.`,
      labName: chosen.labName,
      seatsLeft: chosen.availableSeats - studentCount
    };
  }

  const overallCapacity = labSnapshots.reduce((sum, lab) => sum + lab.availableSeats, 0);
  if (overallCapacity >= studentCount) {
    return {
      success: false,
      message: `No single lab can fit ${studentCount} students at ${examTime} on ${examDate}, but the overall lab capacity is enough. Please choose a different time or split the exam across labs.`
    };
  }

  return {
    success: false,
    message: `No lab can fit ${studentCount} students at ${examTime} on ${examDate}. Please lower the group size or choose another time slot.`
  };
}

function renderExamAllocations() {
  if (!examAllocationTable) return;

  if (!examAllocations.length) {
    examAllocationTable.innerHTML = '<tr><td colspan="5" class="empty">No exams scheduled.</td></tr>';
    return;
  }

  examAllocationTable.innerHTML = examAllocations.map(item => `
    <tr>
      <td>${item.examName}</td>
      <td>${item.students}</td>
      <td>${item.date}</td>
      <td>${item.time}</td>
      <td><span class="badge working">${item.labName}</span></td>
    </tr>
  `).join('');
}

if (examAllocationForm) {
  examAllocationForm.addEventListener('submit', (event) => {
    event.preventDefault();

    const examName = document.getElementById('examCourse').value.trim();
    const studentCount = Number(document.getElementById('examStudentCount').value);
    const examDate = document.getElementById('examDate').value;
    const examTime = document.getElementById('examTime').value;

    if (!examName || !studentCount || !examDate || !examTime) {
      examAllocationResult.textContent = 'Please complete all exam allocation fields.';
      examAllocationResult.className = 'allocation-result error';
      return;
    }

    const result = autoAllocateExamLab(examName, studentCount, examDate, examTime);
    examAllocationResult.textContent = result.message;
    examAllocationResult.className = `allocation-result ${result.success ? 'success' : 'error'}`;

    if (result.success) {
      examAllocationForm.reset();
    }
  });
}

// Auto Monitoring Management
const monitoringTable = document.getElementById('monitoringTable');
const monitorSearchInput = document.getElementById('monitorSearch');
const monitorOnlineCount = document.getElementById('monitorOnlineCount');
const monitorAttentionCount = document.getElementById('monitorAttentionCount');
const monitorOfflineCount = document.getElementById('monitorOfflineCount');
const monitorTotalCount = document.getElementById('monitorTotalCount');

function evaluateMonitoringStatus(item, monitoringEnabledAt) {
  if (!item || !item.lastHeartbeatAt) {
    return { status: 'offline', label: 'Never seen' };
  }
  const heartbeat = item.lastHeartbeatAt?.toDate ? item.lastHeartbeatAt.toDate() : (item.lastHeartbeatAt instanceof Date ? item.lastHeartbeatAt : new Date(item.lastHeartbeatAt));
  const enabledAt = monitoringEnabledAt?.toDate ? monitoringEnabledAt.toDate() : (monitoringEnabledAt instanceof Date ? monitoringEnabledAt : null);
  if (enabledAt && heartbeat < enabledAt) {
    return { status: 'offline', label: 'Waiting for heartbeat' };
  }
  const diffSec = (Date.now() - heartbeat.getTime()) / 1000;

  if (diffSec > 120) {
    return { status: 'offline', label: 'Offline / Stale' };
  }
  if (item.alerts && item.alerts.length > 0) {
    return { status: 'needs_attention', label: 'Needs attention' };
  }
  return { status: 'online', label: 'Online' };
}

function renderMonitoring() {
  if (!monitoringTable) return;
  const filter = (monitorSearchInput?.value || '').toLowerCase().trim();

  let online = 0;
  let attention = 0;
  let offline = 0;

  // Aggregate systems registered with monitoring info
  const rows = systems.map(sys => {
    const monitoringEnabled = sys.monitoringEnabled !== false;
    const monitor = monitoringEnabled ? (monitoringData[sys.systemId] || null) : null;
    const evalResult = monitoringEnabled
      ? evaluateMonitoringStatus(monitor, sys.monitoringEnabledAt)
      : { status: 'offline', label: 'Monitoring off' };

    if (monitoringEnabled) {
      if (evalResult.status === 'online') online++;
      else if (evalResult.status === 'needs_attention') attention++;
      else offline++;
    }

    return {
      systemId: sys.systemId,
      labName: sys.labName,
      monitoringEnabled,
      monitor,
      evalResult
    };
  });

  if (monitorOnlineCount) monitorOnlineCount.textContent = online;
  if (monitorAttentionCount) monitorAttentionCount.textContent = attention;
  if (monitorOfflineCount) monitorOfflineCount.textContent = offline;
  if (monitorTotalCount) monitorTotalCount.textContent = rows.filter(row => row.monitoringEnabled).length;

  const filtered = rows.filter(r => 
    r.systemId.toLowerCase().includes(filter) ||
    (r.labName && r.labName.toLowerCase().includes(filter))
  );

  if (filtered.length === 0) {
    monitoringTable.innerHTML = `<tr><td colspan="9" class="empty">No computers match search criteria.</td></tr>`;
    return;
  }

  monitoringTable.innerHTML = filtered.map(row => {
    const { systemId, labName, monitor, evalResult, monitoringEnabled } = row;
    const hw = monitor?.hardware || {};
    const cpu = hw.cpuPercent !== undefined ? `${hw.cpuPercent.toFixed(1)}%` : '—';
    const cpuVal = hw.cpuPercent || 0;
    const mem = hw.memoryPercent !== undefined ? `${hw.memoryPercent.toFixed(1)}%` : '—';
    const memVal = hw.memoryPercent || 0;
    const disk = hw.diskFreeGb !== undefined ? `${hw.diskFreeGb.toFixed(1)} GB (${hw.diskFreePercent || 0}%)` : '—';

    // Exam software chips
    const swList = monitoringEnabled
      ? (monitor?.examSoftware || []).map(sw => {
          const state = sw.state || (sw.running ? 'running' : (sw.installed ? 'stopped' : 'missing'));
          return `<div class="software-chip"><span class="dot ${state}"></span> ${sw.name}</div>`;
        }).join('')
      : '<span class="muted small">Not monitored</span>';

    // Alerts
    const alerts = (monitor?.alerts || []);
    const alertHtml = !monitoringEnabled
      ? '<span class="muted">Monitoring off</span>'
      : alerts.length > 0
        ? alerts.map(a => `<span class="alert-tag">${a.replace(/_/g, ' ')}</span>`).join('')
        : '<span class="no-alerts">✓ Normal</span>';

    const hbDate = monitor?.lastHeartbeatAt?.toDate ? monitor.lastHeartbeatAt.toDate() : (monitor?.lastHeartbeatAt ? new Date(monitor.lastHeartbeatAt) : null);

    return `
      <tr>
        <td>
          <strong>${systemId}</strong>
          <div class="muted small">${labName || 'Unassigned lab'}</div>
        </td>
        <td>
          <span class="badge ${evalResult.status}">${evalResult.label}</span>
        </td>
        <td>
          <div class="metric-pill">
            <span class="metric-bar-bg">
              <span class="metric-bar-fill ${cpuVal > 90 ? 'danger' : (cpuVal > 70 ? 'warning' : 'normal')}" style="width: ${Math.min(cpuVal, 100)}%"></span>
            </span>
            ${cpu}
          </div>
        </td>
        <td>
          <div class="metric-pill">
            <span class="metric-bar-bg">
              <span class="metric-bar-fill ${memVal > 90 ? 'danger' : (memVal > 70 ? 'warning' : 'normal')}" style="width: ${Math.min(memVal, 100)}%"></span>
            </span>
            ${mem}
          </div>
        </td>
        <td>${disk}</td>
        <td>
          <div class="software-chip-list">
            ${swList || '<span class="muted small">None configured</span>'}
          </div>
        </td>
        <td>${monitoringEnabled ? formatRelativeTime(hbDate) : 'Not monitored'}</td>
        <td>${alertHtml}</td>
        <td>${isAdminUser() ? `<button class="action-btn" type="button" data-monitor-toggle="${systemId}" aria-pressed="${monitoringEnabled}" aria-label="Turn monitoring ${monitoringEnabled ? 'off' : 'on'} for ${systemId}">Turn ${monitoringEnabled ? 'off' : 'on'}</button>` : '<span class="muted">Admin only</span>'}</td>
      </tr>
    `;
  }).join('');
}

if (monitoringTable) {
  monitoringTable.addEventListener('click', async (event) => {
    const toggleButton = event.target.closest('[data-monitor-toggle]');
    if (!toggleButton || !isAdminUser()) return;

    const system = systems.find(item => item.systemId === toggleButton.dataset.monitorToggle);
    if (!system) return;

    const monitoringEnabled = system.monitoringEnabled === false;
    try {
      if (useMock) {
        system.monitoringEnabled = monitoringEnabled;
        system.monitoringEnabledAt = monitoringEnabled ? new Date() : null;
        system.updatedAt = new Date();
      } else {
        await updateDoc(doc(db, 'systems', system.systemId), {
          monitoringEnabled,
          monitoringEnabledAt: monitoringEnabled ? serverTimestamp() : null,
          updatedAt: serverTimestamp(),
          updatedBy: currentUser?.uid || 'unknown'
        });
        system.monitoringEnabled = monitoringEnabled;
        system.monitoringEnabledAt = monitoringEnabled ? new Date() : null;
      }

      renderMonitoring();
      showToast(`Monitoring turned ${monitoringEnabled ? 'on' : 'off'} for ${system.systemId}.`);
    } catch (err) {
      console.error(err);
      showToast(err.message || `Could not change monitoring for ${system.systemId}.`, 'error');
    }
  });
}

if (monitorSearchInput) {
  monitorSearchInput.addEventListener('input', renderMonitoring);
}

// Re-evaluate monitoring status every 15 seconds as specified in README
setInterval(() => {
  renderMonitoring();
}, 15000);

// Overview Page Rendering
function getLabTrackingSummary() {
  const labs = new Map();

  systems.forEach(system => {
    const labName = system.labName || 'Unassigned lab';
    const lab = labs.get(labName) || {
      labName,
      total: 0,
      available: 0,
      broken: 0,
      reservedBy: system.reservedBy || system.labReservedBy || '',
      software: new Set()
    };

    lab.total += 1;
    if (system.status === 'working') lab.available += 1;
    if (system.status === 'not_working' || system.status === 'under_repair' || system.status === 'maintenance') lab.broken += 1;
    if (!lab.reservedBy && (system.reservedBy || system.labReservedBy)) {
      lab.reservedBy = system.reservedBy || system.labReservedBy || '';
    }

    const monitor = monitoringData[system.systemId] || {};
    const swList = Array.isArray(monitor.examSoftware) ? monitor.examSoftware : [];
    swList.forEach(item => {
      if (item && item.name && (item.installed || item.state === 'running')) {
        lab.software.add(item.name);
      }
    });

    labs.set(labName, lab);
  });

  return Array.from(labs.values()).map(lab => {
    const reserved = lab.reservedBy ? `Reserved by ${lab.reservedBy}` : '';
    let status = 'Free';
    let tone = 'free';

    if (reserved) {
      status = reserved;
      tone = 'reserved';
    } else if (lab.available === 0) {
      status = 'No working systems available';
      tone = 'busy';
    } else if (lab.available < lab.total) {
      status = 'Partially available';
      tone = 'busy';
    }

    return {
      ...lab,
      status,
      tone,
      softwareList: Array.from(lab.software).slice(0, 4)
    };
  }).sort((a, b) => b.total - a.total);
}

function renderLabTracking() {
  if (!labTrackingList) return;

  const labs = getLabTrackingSummary();

  if (!labs.length) {
    labTrackingList.innerHTML = '<p class="empty">No lab data available yet.</p>';
    return;
  }

  labTrackingList.innerHTML = labs.map(lab => `
    <div class="lab-tracking-item">
      <div class="lab-header">
        <div>
          <h4>${lab.labName}</h4>
          <p class="muted small">${lab.total} systems total</p>
        </div>
        <span class="lab-state ${lab.tone}">${lab.status}</span>
      </div>
      <div class="lab-meta">
        <div><strong>${lab.available}</strong><span>Available</span></div>
        <div><strong>${lab.broken}</strong><span>Out of order</span></div>
        <div><strong>${lab.total - lab.available}</strong><span>In use / busy</span></div>
      </div>
      <div class="lab-software">
        <span class="software-label">Software ready</span>
        ${lab.softwareList.length ? lab.softwareList.map(name => `<span class="software-tag">${name}</span>`).join('') : '<span class="no-alerts">No software detected</span>'}
      </div>
    </div>
  `).join('');
}

function renderOverview() {
  const total = systems.length;
  const working = systems.filter(s => s.status === 'working').length;
  const broken = systems.filter(s => s.status === 'not_working' || s.status === 'under_repair' || s.status === 'maintenance').length;
  const openFaults = faultReports.filter(f => f.status === 'open' || f.status === 'in_progress').length;

  const totalCountEl = document.getElementById('totalCount');
  const workingCountEl = document.getElementById('workingCount');
  const brokenCountEl = document.getElementById('brokenCount');
  const faultCountEl = document.getElementById('faultCount');

  if (totalCountEl) totalCountEl.textContent = total;
  if (workingCountEl) workingCountEl.textContent = working;
  if (brokenCountEl) brokenCountEl.textContent = broken;
  if (faultCountEl) faultCountEl.textContent = openFaults;

  renderLabTracking();
  renderExamAllocations();

  const overviewSystems = document.getElementById('overviewSystems');
  if (overviewSystems) {
    if (systems.length === 0) {
      overviewSystems.innerHTML = `<tr><td colspan="3" class="empty">No systems registered yet.</td></tr>`;
    } else {
      overviewSystems.innerHTML = systems.slice(0, 5).map(s => `
        <tr>
          <td><strong>${s.systemId}</strong></td>
          <td>${s.labName || '—'}</td>
          <td><span class="badge ${s.status}">${s.status.replace('_', ' ')}</span></td>
        </tr>
      `).join('');
    }
  }

  const recentFaults = document.getElementById('recentFaults');
  if (recentFaults) {
    if (faultReports.length === 0) {
      recentFaults.innerHTML = `<p class="empty">No recent faults reported.</p>`;
    } else {
      recentFaults.innerHTML = faultReports.slice(0, 5).map(f => {
        const d = f.reportedAt?.toDate ? f.reportedAt.toDate() : (f.reportedAt instanceof Date ? f.reportedAt : null);
        return `
          <div class="recent-item">
            <div>
              <div class="recent-item-title">${f.systemId} <span class="badge ${f.priority}">${f.priority}</span></div>
              <div class="recent-item-desc">${f.description}</div>
            </div>
            <span class="badge ${f.status}">${formatRelativeTime(d)}</span>
          </div>
        `;
      }).join('');
    }
  }
}

// Authentication Logic
async function initAuth() {
  if (useMock) {
    console.info('CampusLab: Running in local demo mode. Configure firebase-config.js for production.');
    setupMockData();
    currentUser = null;
    userProfile = { role: 'admin', displayName: 'Administrator' };
    updateUserUI();
    loginView.classList.remove('hidden');
    appView.classList.add('hidden');
    return;
  }

  try {
    const fbApp = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js');
    const fbAuth = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
    const fbFs = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');

    app = fbApp.initializeApp(firebaseConfig);
    auth = fbAuth.getAuth(app);
    db = fbFs.getFirestore(app);

    signInWithEmailAndPassword = fbAuth.signInWithEmailAndPassword;
    createUserWithEmailAndPassword = fbAuth.createUserWithEmailAndPassword;
    signOut = fbAuth.signOut;
    onAuthStateChanged = fbAuth.onAuthStateChanged;

    collection = fbFs.collection;
    doc = fbFs.doc;
    setDoc = fbFs.setDoc;
    addDoc = fbFs.addDoc;
    updateDoc = fbFs.updateDoc;
    deleteDoc = fbFs.deleteDoc;
    onSnapshot = fbFs.onSnapshot;
    getDoc = fbFs.getDoc;
    serverTimestamp = fbFs.serverTimestamp;
    query = fbFs.query;
    orderBy = fbFs.orderBy;
    limit = fbFs.limit;

    onAuthStateChanged(auth, async (user) => {
      currentUser = user;
      if (user) {
        const resolvedRole = getRoleFromEmail(user.email);
        try {
          const userDoc = await getDoc(doc(db, 'users', user.uid));
          if (userDoc.exists()) {
            userProfile = { ...userDoc.data(), role: resolvedRole };
          } else {
            userProfile = { role: resolvedRole, displayName: user.email.split('@')[0] };
          }
        } catch (e) {
          console.warn('Could not read user profile:', e);
          userProfile = { role: resolvedRole, displayName: user.email.split('@')[0] };
        }
        updateUserUI();
        applyRolePermissions();
        loginView.classList.add('hidden');
        appView.classList.remove('hidden');
        bindFirestoreListeners();
      } else {
        loginView.classList.remove('hidden');
        appView.classList.add('hidden');
      }
    });

  } catch (err) {
    console.error('Failed to initialize Firebase SDK:', err);
    useMock = true;
    setupMockData();
    updateUserUI();
  }
}

function updateUserUI() {
  if (userEmailEl) userEmailEl.textContent = currentUser?.email || 'Guest';
  const resolvedRole = getRoleFromEmail(currentUser?.email || userProfile?.email || '');
  if (userRoleEl) userRoleEl.textContent = (userProfile.role || resolvedRole || 'User').replace('_', ' ');
  if (avatarEl) avatarEl.textContent = (currentUser?.email ? currentUser.email[0].toUpperCase() : 'U');
}

function setAuthFormMode(mode) {
  const isLogin = mode === 'login';
  authModeButtons.forEach(button => {
    const active = button.dataset.mode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });

  if (loginForm) loginForm.classList.toggle('hidden', !isLogin);
  if (signupForm) signupForm.classList.toggle('hidden', isLogin);

  if (authTitle) authTitle.textContent = isLogin ? 'Welcome back' : 'Create your account';
  if (authSubtitle) authSubtitle.textContent = isLogin ? 'Sign in to access your lab operations workspace.' : 'Create an account to report issues and manage lab operations.';

  if (loginError) loginError.textContent = '';
  if (signupError) signupError.textContent = '';
}

authModeButtons.forEach(button => {
  button.addEventListener('click', () => setAuthFormMode(button.dataset.mode));
});

if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    if (!email || !password) {
      loginError.textContent = 'Please enter your email and password.';
      return;
    }

    if (useMock) {
      try {
        const account = getMockAccounts().find(item => item.email === email.toLowerCase());
        if (!account) {
          loginError.textContent = 'Email not found. Create your account first.';
          return;
        }
        if (!await verifyMockPassword(account, password)) {
          loginError.textContent = 'Incorrect password.';
          return;
        }

        currentUser = { uid: `mock-user-${email.toLowerCase()}`, email };
        userProfile = {
          role: getRoleFromEmail(email),
          displayName: account.displayName || email.split('@')[0]
        };
      } catch (err) {
        console.error('Could not read demo accounts:', err);
        loginError.textContent = 'Unable to check saved accounts. Please try again.';
        return;
      }
      updateUserUI();
      applyRolePermissions();
      loginView.classList.add('hidden');
      appView.classList.remove('hidden');
      renderOverview();
      renderSystems();
      renderFaults();
      renderMonitoring();
      showToast(`Signed in successfully as ${userProfile.role} (demo mode)`);
      return;
    }

    try {
      await signInWithEmailAndPassword(auth, email, password);
      showToast('Signed in successfully');
    } catch (err) {
      console.error(err);
      if (err.code === 'auth/user-not-found') {
        loginError.textContent = 'Email not found. Create your account first.';
      } else if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
        loginError.textContent = 'Incorrect password.';
      } else {
        loginError.textContent = err.message || 'Unable to log in. Please try again.';
      }
    }
  });
}

if (signupForm) {
  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    signupError.textContent = '';

    const name = document.getElementById('signupName').value.trim();
    const email = document.getElementById('signupEmail').value.trim();
    const password = document.getElementById('signupPassword').value;
    const confirmPassword = document.getElementById('signupConfirmPassword').value;

    if (!name || !email || !password) {
      signupError.textContent = 'Please complete all account details.';
      return;
    }

    if (password.length < 6) {
      signupError.textContent = 'Password must be at least 6 characters.';
      return;
    }

    if (password !== confirmPassword) {
      signupError.textContent = 'Passwords do not match.';
      return;
    }

    if (useMock) {
      try {
        const accounts = getMockAccounts();
        const existingAccount = accounts.find(account => account.email === email.toLowerCase());
        if (existingAccount?.passwordHash) {
          setAuthFormMode('login');
          loginError.textContent = 'An account with this email already exists. Please log in.';
          return;
        }

        const passwordVerifier = await createPasswordVerifier(password);
        if (existingAccount) {
          Object.assign(existingAccount, { displayName: name, ...passwordVerifier });
        } else {
          accounts.push({ email: email.toLowerCase(), displayName: name, ...passwordVerifier });
        }
        localStorage.setItem(MOCK_ACCOUNTS_KEY, JSON.stringify(accounts));
      } catch (err) {
        console.error('Could not save demo account:', err);
        signupError.textContent = 'Unable to create your account. Please try again.';
        return;
      }

      currentUser = { uid: `mock-user-${Date.now()}`, email };
      userProfile = {
        role: getRoleFromEmail(email),
        displayName: name
      };
      updateUserUI();
      applyRolePermissions();
      loginView.classList.add('hidden');
      appView.classList.remove('hidden');
      renderOverview();
      renderSystems();
      renderFaults();
      renderMonitoring();
      showToast(`Account created successfully as ${userProfile.role} (demo mode)`);
      signupForm.reset();
      setAuthFormMode('login');
      return;
    }

    try {
      if (createUserWithEmailAndPassword) {
        await createUserWithEmailAndPassword(auth, email, password);
        showToast('Account created successfully');
        setAuthFormMode('login');
        signupForm.reset();
      } else {
        signupError.textContent = 'Create account is unavailable in the current setup.';
      }
    } catch (err) {
      console.error(err);
      signupError.textContent = err.message || 'Unable to create account.';
    }
  });
}

if (signOutBtn) {
  signOutBtn.addEventListener('click', async () => {
    if (useMock) {
      currentUser = null;
      loginView.classList.remove('hidden');
      appView.classList.add('hidden');
      showToast('Signed out');
      return;
    }
    try {
      await signOut(auth);
      showToast('Signed out');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

function bindFirestoreListeners() {
  // Listen to systems
  onSnapshot(collection(db, 'systems'), (snapshot) => {
    systems = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderSystems();
    renderOverview();
    renderMonitoring();
  }, (err) => console.error('systems listener error:', err));

  // Listen to fault reports
  onSnapshot(query(collection(db, 'faultReports'), orderBy('reportedAt', 'desc')), (snapshot) => {
    faultReports = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderFaults();
    renderOverview();
  }, (err) => console.error('faultReports listener error:', err));

  // Listen to monitoring
  onSnapshot(collection(db, 'monitoring'), (snapshot) => {
    const data = {};
    snapshot.docs.forEach(d => {
      data[d.id] = d.data();
    });
    monitoringData = data;
    renderMonitoring();
  }, (err) => console.error('monitoring listener error:', err));
}

// Local mock data when Firebase is unconfigured
function setupMockData() {
  const addGeneratedLabSystems = (labName, prefix, total, issueIndexes = []) => {
    const timestamp = Date.now();
    return Array.from({ length: total }, (_, index) => {
      const systemNumber = index + 1;
      const status = issueIndexes.includes(systemNumber)
        ? 'not_working'
        : (systemNumber % 9 === 0 ? 'under_repair' : 'working');

      return {
        systemId: `${prefix}${String(systemNumber).padStart(3, '0')}`,
        labName,
        status,
        notes: `${labName} workstation ${systemNumber}`,
        updatedAt: new Date(timestamp - (index * 120000))
      };
    });
  };

  systems = [
    ...addGeneratedLabSystems('Computer Lab 1', 'LAB1-PC-', 20, [3, 9]),
    ...addGeneratedLabSystems('Main Examination Hall', 'EXAM-HALL-', 40, [12, 28, 34]),
    ...addGeneratedLabSystems('CAD Lab 2', 'LAB2-PC-', 18, [5, 14]),
    ...addGeneratedLabSystems('Programming Lab 3', 'LAB3-PC-', 22, [7, 16, 21]),
    ...addGeneratedLabSystems('Data Science Lab 4', 'LAB4-PC-', 18, [4, 11, 17]),
    ...addGeneratedLabSystems('Network Lab 5', 'LAB5-PC-', 18, [6, 13]),
    ...addGeneratedLabSystems('General Lab 6', 'LAB6-PC-', 20, [8, 18])
  ];

  faultReports = [
    { id: 'f-1', systemId: 'LAB1-PC-003', priority: 'high', description: 'Screen flashes black and system shuts down after 5 minutes.', status: 'open', reportedAt: new Date(Date.now() - 1800000) },
    { id: 'f-2', systemId: 'LAB2-PC-011', priority: 'normal', description: 'Mouse scroll wheel not functioning properly.', status: 'in_progress', reportedAt: new Date(Date.now() - 86400000) },
    { id: 'f-3', systemId: 'LAB3-PC-022', priority: 'urgent', description: 'Mouse disconnects repeatedly during coding practice.', status: 'open', reportedAt: new Date(Date.now() - 900000) },
    { id: 'f-4', systemId: 'LAB3-PC-024', priority: 'high', description: 'System is stuck on pending OS update.', status: 'in_progress', reportedAt: new Date(Date.now() - 7200000) },
    { id: 'f-5', systemId: 'LAB4-PC-033', priority: 'high', description: 'GPU driver issue during Python lab sessions.', status: 'open', reportedAt: new Date(Date.now() - 600000) }
  ];

  monitoringData = {
    'LAB1-PC-001': {
      systemId: 'LAB1-PC-001',
      hostname: 'LAB1-PC-001',
      agentVersion: '1.0.0',
      lastHeartbeatAt: new Date(),
      hardware: { cpuPercent: 18.4, memoryPercent: 44.5, diskFreeGb: 112.5, diskFreePercent: 46.8 },
      examSoftware: [
        { name: 'Windows 11', installed: true, running: true, state: 'running' },
        { name: 'Ubuntu 22.04', installed: true, running: true, state: 'running' },
        { name: 'Linux Mint', installed: true, running: false, state: 'stopped' },
        { name: 'Python', installed: true, running: true, state: 'running' },
        { name: 'JupyterLab', installed: true, running: true, state: 'running' },
        { name: 'n8n', installed: true, running: false, state: 'stopped' },
        { name: 'StarUML', installed: true, running: false, state: 'stopped' },
        { name: 'Modelio', installed: true, running: false, state: 'stopped' }
      ],
      alerts: []
    },
    'LAB1-PC-002': {
      systemId: 'LAB1-PC-002',
      hostname: 'LAB1-PC-002',
      agentVersion: '1.0.0',
      lastHeartbeatAt: new Date(Date.now() - 45000),
      hardware: { cpuPercent: 94.2, memoryPercent: 88.0, diskFreeGb: 14.2, diskFreePercent: 8.5 },
      examSoftware: [
        { name: 'Safe Exam Browser', installed: true, running: true, state: 'running' },
        { name: 'NPTEL Exam Client', installed: false, running: false, state: 'missing' },
        { name: 'Visual Studio Code', installed: true, running: true, state: 'running' }
      ],
      alerts: ['cpu_high_94_percent', 'disk_free_low_8_percent', 'missing_nptel_exam_client']
    },
    'LAB1-PC-004': {
      systemId: 'LAB1-PC-004',
      hostname: 'LAB1-PC-004',
      agentVersion: '1.0.0',
      lastHeartbeatAt: new Date(Date.now() - 120000),
      hardware: { cpuPercent: 40.6, memoryPercent: 57.8, diskFreeGb: 95.0, diskFreePercent: 48.0 },
      examSoftware: [
        { name: 'Safe Exam Browser', installed: true, running: false, state: 'stopped' },
        { name: 'Google Chrome', installed: true, running: true, state: 'running' }
      ],
      alerts: []
    },
    'LAB1-PC-005': {
      systemId: 'LAB1-PC-005',
      hostname: 'LAB1-PC-005',
      agentVersion: '1.0.0',
      lastHeartbeatAt: new Date(Date.now() - 200000),
      hardware: { cpuPercent: 51.4, memoryPercent: 63.1, diskFreeGb: 76.5, diskFreePercent: 43.0 },
      examSoftware: [
        { name: 'Safe Exam Browser', installed: true, running: false, state: 'stopped' },
        { name: 'Browser', installed: true, running: true, state: 'running' }
      ],
      alerts: []
    },
    'EXAM-HALL-001': {
      systemId: 'EXAM-HALL-001',
      hostname: 'EXAM-HALL-001',
      agentVersion: '1.0.0',
      lastHeartbeatAt: new Date(Date.now() - 20000),
      hardware: { cpuPercent: 19.0, memoryPercent: 38.2, diskFreeGb: 245.0, diskFreePercent: 71.0 },
      examSoftware: [
        { name: 'Safe Exam Browser', installed: true, running: true, state: 'running' },
        { name: 'Proctoring Suite', installed: true, running: true, state: 'running' }
      ],
      alerts: []
    },
    'EXAM-HALL-002': {
      systemId: 'EXAM-HALL-002',
      hostname: 'EXAM-HALL-002',
      agentVersion: '1.0.0',
      lastHeartbeatAt: new Date(Date.now() - 25000),
      hardware: { cpuPercent: 16.0, memoryPercent: 34.7, diskFreeGb: 260.0, diskFreePercent: 74.2 },
      examSoftware: [
        { name: 'Safe Exam Browser', installed: true, running: true, state: 'running' },
        { name: 'Proctoring Suite', installed: true, running: true, state: 'running' }
      ],
      alerts: []
    },
    'LAB2-PC-010': {
      systemId: 'LAB2-PC-010',
      hostname: 'LAB2-PC-010',
      agentVersion: '1.0.0',
      lastHeartbeatAt: new Date(Date.now() - 300000),
      hardware: { cpuPercent: 12.0, memoryPercent: 32.1, diskFreeGb: 220.0, diskFreePercent: 65.0 },
      examSoftware: [
        { name: 'Safe Exam Browser', installed: true, running: false, state: 'stopped' },
        { name: 'AutoCAD', installed: true, running: true, state: 'running' }
      ],
      alerts: []
    },
    'LAB2-PC-012': {
      systemId: 'LAB2-PC-012',
      hostname: 'LAB2-PC-012',
      agentVersion: '1.0.0',
      lastHeartbeatAt: new Date(Date.now() - 85000),
      hardware: { cpuPercent: 26.8, memoryPercent: 48.2, diskFreeGb: 144.0, diskFreePercent: 58.0 },
      examSoftware: [
        { name: 'AutoCAD', installed: true, running: true, state: 'running' },
        { name: 'SolidWorks', installed: true, running: false, state: 'stopped' }
      ],
      alerts: []
    },
    'LAB2-PC-013': {
      systemId: 'LAB2-PC-013',
      hostname: 'LAB2-PC-013',
      agentVersion: '1.0.0',
      lastHeartbeatAt: new Date(Date.now() - 90000),
      hardware: { cpuPercent: 22.3, memoryPercent: 35.7, diskFreeGb: 170.0, diskFreePercent: 61.5 },
      examSoftware: [
        { name: 'AutoCAD', installed: true, running: true, state: 'running' }
      ],
      alerts: []
    },
    'LAB3-PC-020': {
      systemId: 'LAB3-PC-020',
      hostname: 'LAB3-PC-020',
      agentVersion: '1.0.0',
      lastHeartbeatAt: new Date(Date.now() - 50000),
      hardware: { cpuPercent: 28.7, memoryPercent: 41.1, diskFreeGb: 134.5, diskFreePercent: 51.7 },
      examSoftware: [
        { name: 'Windows 11', installed: true, running: true, state: 'running' },
        { name: 'Ubuntu 22.04', installed: true, running: true, state: 'running' },
        { name: 'Linux Mint', installed: true, running: false, state: 'stopped' },
        { name: 'Python', installed: true, running: true, state: 'running' },
        { name: 'JupyterLab', installed: true, running: true, state: 'running' },
        { name: 'n8n', installed: true, running: true, state: 'running' },
        { name: 'StarUML', installed: true, running: false, state: 'stopped' },
        { name: 'Modelio', installed: true, running: false, state: 'stopped' }
      ],
      alerts: []
    },
    'LAB3-PC-021': {
      systemId: 'LAB3-PC-021',
      hostname: 'LAB3-PC-021',
      agentVersion: '1.0.0',
      lastHeartbeatAt: new Date(Date.now() - 110000),
      hardware: { cpuPercent: 62.5, memoryPercent: 72.4, diskFreeGb: 52.0, diskFreePercent: 23.0 },
      examSoftware: [
        { name: 'VS Code', installed: true, running: true, state: 'running' },
        { name: 'Python', installed: true, running: false, state: 'stopped' }
      ],
      alerts: ['cpu_high_62_percent']
    },
    'LAB3-PC-023': {
      systemId: 'LAB3-PC-023',
      hostname: 'LAB3-PC-023',
      agentVersion: '1.0.0',
      lastHeartbeatAt: new Date(Date.now() - 190000),
      hardware: { cpuPercent: 35.7, memoryPercent: 46.2, diskFreeGb: 130.0, diskFreePercent: 49.0 },
      examSoftware: [
        { name: 'Java Compiler', installed: true, running: true, state: 'running' },
        { name: 'VS Code', installed: true, running: true, state: 'running' }
      ],
      alerts: []
    },
    'LAB4-PC-030': {
      systemId: 'LAB4-PC-030',
      hostname: 'LAB4-PC-030',
      agentVersion: '1.0.0',
      lastHeartbeatAt: new Date(Date.now() - 70000),
      hardware: { cpuPercent: 29.3, memoryPercent: 41.8, diskFreeGb: 150.5, diskFreePercent: 57.2 },
      examSoftware: [
        { name: 'Python', installed: true, running: true, state: 'running' },
        { name: 'Jupyter', installed: true, running: false, state: 'stopped' }
      ],
      alerts: []
    },
    'LAB4-PC-031': {
      systemId: 'LAB4-PC-031',
      hostname: 'LAB4-PC-031',
      agentVersion: '1.0.0',
      lastHeartbeatAt: new Date(Date.now() - 120000),
      hardware: { cpuPercent: 34.0, memoryPercent: 54.1, diskFreeGb: 115.0, diskFreePercent: 49.0 },
      examSoftware: [
        { name: 'Python', installed: true, running: true, state: 'running' },
        { name: 'Jupyter', installed: true, running: true, state: 'running' }
      ],
      alerts: []
    },
    'LAB5-PC-040': {
      systemId: 'LAB5-PC-040',
      hostname: 'LAB5-PC-040',
      agentVersion: '1.0.0',
      lastHeartbeatAt: new Date(Date.now() - 50000),
      hardware: { cpuPercent: 21.5, memoryPercent: 42.7, diskFreeGb: 160.5, diskFreePercent: 61.1 },
      examSoftware: [
        { name: 'Packet Tracer', installed: true, running: true, state: 'running' }
      ],
      alerts: []
    },
    'LAB6-PC-050': {
      systemId: 'LAB6-PC-050',
      hostname: 'LAB6-PC-050',
      agentVersion: '1.0.0',
      lastHeartbeatAt: new Date(Date.now() - 80000),
      hardware: { cpuPercent: 24.6, memoryPercent: 44.1, diskFreeGb: 177.0, diskFreePercent: 64.5 },
      examSoftware: [
        { name: 'General Browser', installed: true, running: true, state: 'running' }
      ],
      alerts: []
    }
  };
}

// Start application
initAuth();
