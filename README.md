<<<<<<< HEAD
# College Lab Management System — CampusLab

CampusLab provides a secure college computer lab operations, fault tracking, and live Windows computer monitoring solution. It comprises:
1. **Frontend Dashboard:** HTML5, CSS3, ES modules with Firebase Auth and Firestore.
2. **Monitoring API:** Node.js/Express service that validates per-computer bearer tokens, bounds-checks telemetry, and writes snapshots/events using Firebase Admin SDK.
3. **Windows Agent:** PowerShell 5.1+ agent executing as a Scheduled Task under `SYSTEM` reporting every 60 seconds over HTTPS.
4. **Firestore Security Rules:** Strict role-based client access forbidding direct browser writes to monitoring documents.

---

## Architecture Overview

- **Dashboard:** Reads `systems` and `monitoring` collections via Firebase Authentication + Firestore rules. Allows lab staff and technicians to register systems, log faults, and view live computer metrics.
- **Windows Agent:** Collects CPU, RAM, system disk free space, and exam application states. Posts payload over TLS 1.2+ to the monitoring API with a per-machine bearer token.
- **Monitoring API:** Authenticates token, verifies machine registration in Firestore, bounds-checks metrics, updates `monitoring/{systemId}`, and records health transition events in `monitoringEvents`.
- **Firestore:**
  - `systems/{systemId}`: registered computers and manual operational status.
  - `monitoring/{systemId}`: latest snapshot of live telemetry (server writes only).
  - `monitoringEvents/{autoId}`: recorded on first-seen or health/alert state changes (server writes only).
  - `faultReports/{autoId}`: issue tracking.
  - `users/{uid}`: user profiles with roles (`admin`, `lab_staff`, `technician`).

---

## Directory Structure

```text
campuslab/
├── assets/
│   └── campuslab.svg
├── css/
│   ├── style.css
│   └── professional-overrides.css
├── js/
│   ├── firebase-config.js
│   └── app.js
├── monitoring-api/
│   ├── .env.example
│   ├── package.json
│   └── server.js
├── windows-agent/
│   ├── agent-config.example.json
│   ├── agent.ps1
│   └── install-agent.ps1
├── firestore.rules
├── index.html
└── README.md
```

---

## 1. Firebase Setup

1. Create a Firebase project at [Firebase Console](https://console.firebase.google.com/).
2. In Project settings, create a **Web App** and copy the configuration into `campuslab/js/firebase-config.js`.
   > **Important:** Never put service account private keys in `firebase-config.js`.
3. In Authentication → Sign-in method, enable **Email/Password**.
4. In Firestore Database, create a database and publish the contents of `campuslab/firestore.rules`.
5. Under Authentication → Users, create your initial administrator account. Then in Firestore, create document `users/{UID}`:
   ```json
   {
     "displayName": "Lab Administrator",
     "email": "admin@college.edu",
     "role": "admin"
   }
   ```
   *(Roles available: `admin`, `lab_staff`, `technician`)*.

---

## 2. Running the Dashboard Locally

Serve `campuslab/` over HTTP (or HTTPS):

```powershell
cd campuslab
python -m http.server 5500
```

Open `http://localhost:5500` in your browser.
*(Note: If Firebase credentials are not yet configured in `firebase-config.js`, CampusLab will automatically run in local interactive demo mode so you can preview the complete UI and simulated live telemetry).*

---

## 3. Monitoring API Setup

1. Navigate to the API directory:
   ```powershell
   cd campuslab/monitoring-api
   npm install
   Copy-Item .env.example .env
   ```
2. Generate a random 256-bit token for each computer in PowerShell:
   ```powershell
   $bytes = New-Object byte[] 32; $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }; [BitConverter]::ToString($bytes).Replace('-', '')
   ```
3. Edit `.env`:
   ```dotenv
   PORT=8787
   DASHBOARD_ORIGINS=http://localhost:5500,https://campuslab.college.edu
   AGENT_TOKENS_JSON={"LAB1-PC-001":"GENERATED_TOKEN_1","LAB1-PC-002":"GENERATED_TOKEN_2"}
   GOOGLE_APPLICATION_CREDENTIALS=C:\Secure\service-account.json
   ```
4. Start the service:
   ```powershell
   npm start
   ```
   Check health: `http://localhost:8787/healthz`.

---

## 4. Windows Agent Installation

On each target Windows 10/11 lab PC:

1. Copy `campuslab/windows-agent/` to the PC.
2. Edit `agent-config.example.json` if custom exam software paths need to be added.
3. Open **PowerShell as Administrator** and run:
   ```powershell
   .\install-agent.ps1 -SystemId 'LAB1-PC-001' -ApiUrl 'https://monitoring-api.college.edu' -Token 'GENERATED_TOKEN_1' -ConfigSource '.\agent-config.example.json'
   ```
4. The installer configures:
   - Target directory `%ProgramData%\CollegeLabMonitor` with locked NTFS permissions (SYSTEM & Administrators only).
   - Scheduled Task `CollegeLabMonitorAgent` running every 60 seconds.

### Useful Agent Commands

- Check scheduled task:
  ```powershell
  Get-ScheduledTask -TaskName CollegeLabMonitorAgent
  ```
- Inspect recent logs:
  ```powershell
  Get-Content "$env:ProgramData\CollegeLabMonitor\agent.log" -Tail 30
  ```
- Trigger immediate run:
  ```powershell
  Start-ScheduledTask -TaskName CollegeLabMonitorAgent
  ```
- Uninstall agent:
  ```powershell
  Stop-ScheduledTask -TaskName CollegeLabMonitorAgent -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName CollegeLabMonitorAgent -Confirm:$false
  Remove-Item "$env:ProgramData\CollegeLabMonitor" -Recurse -Force
  ```

---

## 5. Security Summary

- **No client-side tokens:** The web dashboard never receives agent tokens or private keys.
- **Least privilege:** Firestore client rules allow reads, but all updates to `monitoring` and `monitoringEvents` must go through the Node.js API with Firebase Admin SDK.
- **Agent access control:** Each PC has an isolated token. If one machine is compromised, only that machine's token needs to be rotated.
- **Encrypted transport:** Agents reject plain HTTP and enforce TLS 1.2+ HTTPS endpoints.
=======
# smart-lab-management
>>>>>>> 66cc466aa0c4943dd4aa0bf932fe29a10052ae6c
