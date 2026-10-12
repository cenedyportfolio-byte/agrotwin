# AgroTwin v2 — Linux Setup & Production Workflow Guide

This document provides complete instructions for running **AgroTwin v2**, **Solution B (WebODM / OpenDroneMap)**, and **3D Gaussian Splatting (`gsplat`)** on a Linux machine (Ubuntu 22.04/24.04 LTS recommended).

---

## 1. System Prerequisites

### A. NVIDIA Drivers & CUDA Toolkit
To enable GPU acceleration for PyTorch, OpenCV, and 3D Gaussian Splatting:

```bash
# 1. Update package lists
sudo apt update && sudo apt upgrade -y

# 2. Install recommended NVIDIA driver (e.g., 535 or 550+)
sudo ubuntu-drivers install
# Or: sudo apt install -y nvidia-driver-550

# 3. Reboot system
sudo reboot

# 4. Verify GPU status and CUDA capability
nvidia-smi
```

### B. Docker & NVIDIA Container Toolkit (for WebODM)
Unlike Windows which runs Docker inside WSL2 virtualization, Linux runs Docker containers with native near-zero overhead:

```bash
# 1. Install Docker Engine
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
newgrp docker

# 2. Install NVIDIA Container Toolkit (allows Docker to access your GPU)
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list

sudo apt update
sudo apt install -y nvidia-container-toolkit
sudo systemctl restart docker

# 3. Test GPU in Docker
docker run --rm --gpus all nvidia/cuda:12.4.0-base-ubuntu22.04 nvidia-smi
```

### C. Python 3.11, uv & Node.js 20+
```bash
# Install system build dependencies
sudo apt install -y build-essential git curl libgdal-dev libgl1 libglib2.0-0

# Install uv (ultra-fast Python package installer)
curl -LsSf https://astral.sh/uv/install.sh | sh
source $HOME/.cargo/env

# Install Node.js 20+ via NodeSource
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

---

## 2. AgroTwin Project Setup on Linux

### Step 1: Clone Repository
```bash
git clone <repo_url> argoTwinv2
cd argoTwinv2
```

### Step 2: Backend Virtual Environment (with CUDA PyTorch)
```bash
# Create Python 3.11 virtualenv
uv venv backend/.venv-gpu --python 3.11

# Activate virtualenv
source backend/.venv-gpu/bin/activate

# Install PyTorch with CUDA 12.4+
uv pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124

# Install backend dependencies
uv pip install -r backend/requirements.txt
```

Verify GPU availability in Python:
```bash
python3 -c "import torch; print('CUDA Available:', torch.cuda.is_available(), '| Device:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'None')"
```

### Step 3: Frontend Dependencies & Cesium Assets
```bash
cd frontend
npm ci
node scripts/copy-cesium.mjs
cd ..
```

---

## 3. Running WebODM (Solution B) on Linux

WebODM is the survey-grade photogrammetry engine that completely eliminates **ghosting** and **zoom-in blur**.

### Step 1: Launch WebODM via Docker
```bash
# Clone WebODM repository
git clone https://github.com/OpenDroneMap/WebODM --config core.autocrlf=input --depth 1
cd WebODM

# Start WebODM (runs on port 8000 by default; change port to 8080 so AgroTwin can use 8000)
./webodm.sh start --port 8080
```
WebODM will be accessible at: `http://localhost:8080`.

### Step 2: Processing Multi-Battery Missions (Missions 012 + 013)
1. In WebODM, create a new project: **"Ditty Road Soybean Field"**.
2. Select **Add Images** and drag all **230 image pairs** from both:
   - `Data/DJI_202606031411_012_DittyRoadSoybeanfield`
   - `Data/DJI_202606031442_013_DittyRoadSoybeanfield`
3. Configure the following recommended agricultural parameters:

| Parameter | Value | Purpose |
| :--- | :--- | :--- |
| `dsm` | `true` | Creates elevation surface model for terrain orthorectification |
| `dtm` | `true` | Creates bare-earth elevation model |
| `orthophoto-resolution` | `0.8` | Enforces 0.8 cm/px native drone camera resolution |
| `feature-quality` | `high` | SIFT feature extraction across uniform soybean rows |
| `mesh-size` | `200000` | Builds dense 3D reality mesh for CesiumJS |
| `radiometric-calibration` | `camera` | Uses Mavic 3M sunshine sensor tags |

4. Click **Start Processing**. On Linux with an NVIDIA GPU, this typically completes in 25–35 minutes.

### Step 3: Importing ODM Assets into AgroTwin
Once WebODM finishes, download the project assets or point AgroTwin's import script directly to the task directory:

```bash
# From argoTwinv2 root directory:
backend/.venv-gpu/bin/python3 -m scripts.import_odm \
  --survey cb0880056259 \
  --odm-dir /path/to/WebODM/app/media/project/task
```

This will automatically:
1. Register `orthomosaic_odm.tif`, `dsm_odm.tif`, and `dtm_odm.tif`.
2. Convert the 3D textured mesh into 3D Tiles (`frontend/public/models/cb0880056259/odm-model/tileset.json`).
3. Generate the 14,000+ tile WebP pyramid down to **Zoom Level 24** (`frontend/public/tiles/cb0880056259/orthomosaic/`).
4. Set `SOURCE_RANK = {"photogrammetry_odm": 0}` so the survey viewer displays the ODM orthomosaic.

---

## 4. Running 3D Gaussian Splatting (`gsplat`) on Linux

AgroTwin includes an in-repo 3D Gaussian Splatting trainer that generates high-fidelity real-time 3D twins directly on your NVIDIA GPU:

```bash
# Run training script
source backend/.venv-gpu/bin/activate
python3 -m scripts.gsplat_train --survey cb0880056259 --steps 30000 --cap-max 1500000 --save-every 5000
```

### Monitoring GPU Telemetry in Real-Time:
Open a separate terminal and run:
```bash
watch -n 1 nvidia-smi
```
You should observe:
- **GPU-Util**: 95%–100%
- **VRAM**: ~2.6 GB – 3.2 GB allocated
- **Power**: GPU at maximum rated wattage (e.g. 40W–45W on RTX 3050 Laptop)

---

## 5. Starting & Stopping AgroTwin Services

Use the unified Linux launcher [`linux/run.sh`](./run.sh):

```bash
# Development mode (hot reload)
./linux/run.sh dev

# Production mode (optimized build)
./linux/run.sh prod

# Expose on Local Network (for tablet/mobile access)
./linux/run.sh --lan prod

# Stop all background services cleanly
./linux/run.sh stop
```

---

## 6. Linux Performance & Stability Tips

1. **Increase File Descriptor Limits (Avoid `EMFILE` in Webpack/Cesium)**:
   ```bash
   sudo sysctl -w fs.file-max=2097152
   sudo sysctl -w fs.inotify.max_user_watches=524288
   ```
2. **NVIDIA Persistence Mode**:
   Keeps the NVIDIA GPU driver initialized to avoid initial CUDA context spin-up latency:
   ```bash
   sudo nvidia-smi -pm 1
   ```
3. **No exFAT File Locking**:
   Unlike Windows exFAT drives, native ext4 filesystems handle SQLite WAL mode and Next.js LMDB caching without lock degradation.
