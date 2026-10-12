# AgroTwin v2 - External HDD Setup & Backup Guide

This copy of the project was created from `/home/cdev/Development/argoTwinv2` on **September 28, 2026**.

To save space and enable fast transfers (~260 MB total transferred instead of 6.4+ GB), runtime dependency caches and build artifacts (`node_modules`, `.venv`, `.gradle`, `build/`, etc.) were excluded. This document details how to restore dependencies and run the project directly from this drive.

---

## 1. Quick Start: Re-installing Dependencies

### A. Frontend (Next.js)
```bash
cd frontend
npm install
npm run dev
```

### B. Mobile (Expo / React Native)
```bash
cd mobile
npm install
npx expo start
```
*(Note: A pre-built standalone APK is already preserved at `mobile/agrotwin.apk`)*.

### C. Backend (FastAPI / Python)
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```
*For GPU / CUDA processing features (if running on a Windows/CUDA machine):*
```bash
pip install -r requirements-gpu.txt
```

---

## 2. Backup & Sync Specifications

### Excluded from Transfer:
- `node_modules/` (Frontend & Mobile dependency trees ~3.7 GB)
- `mobile/android/app/build/` and `.gradle/` (~2.5 GB)
- `.venv*`, `venv*`, `env*`, and `__pycache__` / `*.pyc`
- `.cache/`, `.next/`, `.expo/`

### Preserved in this Copy:
- Full source code for **Backend**, **Frontend**, and **Mobile**
- Complete Git repository history (`.git`)
- Project configuration, environment templates, and secrets (`.env`, `.env.example`)
- Technical documentation, audit reports, and setup scripts (`run.ps1`, `run.sh`, `setup.sh`)
- Standalone Android APK: `mobile/agrotwin.apk` (110 MB)

---

## 3. Important: exFAT Filesystem Note

This external drive is formatted with the **exFAT** filesystem.
exFAT does not support POSIX permission bits (chmod/exec flags). To prevent Git from detecting all files as modified due to permission differences, the repository on this drive has been configured with:

```bash
git config core.filemode false
```

If you ever clone or initialize fresh git repos on this drive, remember to run that command.

---

## 4. Exact Sync Commands Run

```bash
# 1. Verify destination mount & space
df -h /media/cdev/Personal1 && ls -ld /media/cdev/Personal1

# 2. Rsync transfer excluding dependency trees and build caches
rsync -rtvh --modify-window=1 --stats \
  --exclude="node_modules" \
  --exclude=".venv*" \
  --exclude="venv*" \
  --exclude="env*" \
  --exclude="__pycache__" \
  --exclude="*.pyc" \
  --exclude=".cache" \
  --exclude=".next" \
  --exclude=".expo" \
  --exclude=".gradle" \
  --exclude="build" \
  --exclude="*.build" \
  /home/cdev/Development/argoTwinv2/ /media/cdev/Personal1/argoTwinv2/

# 3. Configure Git for exFAT compatibility
cd /media/cdev/Personal1/argoTwinv2
git config core.filemode false

# 4. Flush write buffer to disk
sync
```
