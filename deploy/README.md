# Installing AgroTwin on the university server

For the person setting up the server. Farmers only ever see the website
(`https://agrotwin.example.edu`); everything below runs on one Linux machine
with an NVIDIA GPU.

```
farmer's phone ──https──> nginx ──> web app (Next.js, :3000)
                            ├────> API (FastAPI, :8000) ──> Docker: OpenDroneMap (detailed maps)
                            │                          └──> Ollama (assistant, :11434)
                            └────> map tiles / 3D files from disk (each checked with the API first)
```

## What the server needs

| | |
|---|---|
| OS | Ubuntu 22.04 or 24.04 LTS |
| GPU | NVIDIA, 16 GB memory or more (the assistant model uses ~9 GB; map processing and OpenDroneMap share the rest) |
| CPU / RAM | 16+ cores, 64 GB RAM — OpenDroneMap is the heavy part |
| Disk | 10–15 GB per flight (photos, maps, 3D model). 50 farmers × 6 flights a season ≈ 4 TB |
| Network | a DNS name (e.g. `agrotwin.example.edu`), ports 80 and 443 open; nothing else needs to be reachable |
| Software | NVIDIA driver, Docker + NVIDIA Container Toolkit, Python 3.12, Node.js 20+, nginx, certbot, git |

Ports 3000, 8000 and 11434 stay on `127.0.0.1`; only nginx faces the internet.

## 1. System packages

```bash
sudo apt update
sudo apt install -y git nginx certbot python3.12 python3.12-venv python3.12-dev build-essential sqlite3
# Node.js 20+ (e.g. from NodeSource), the NVIDIA driver, Docker Engine and the
# NVIDIA Container Toolkit — follow their official install guides, then check:
nvidia-smi
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

## 2. User, folders, code

```bash
sudo useradd --system --create-home --shell /bin/bash agrotwin
sudo usermod -aG docker agrotwin          # it starts OpenDroneMap containers
sudo mkdir -p /opt/agrotwin /srv/agrotwin/data /srv/agrotwin/backups /etc/agrotwin
sudo chown -R agrotwin:agrotwin /opt/agrotwin /srv/agrotwin
sudo -u agrotwin git clone <repository URL> /opt/agrotwin
```

Membership of the `docker` group is root-equivalent on that machine. If that
is not acceptable, run Docker rootless for the `agrotwin` user instead.

## 3. Settings

```bash
sudo cp /opt/agrotwin/deploy/agrotwin.env.example /etc/agrotwin/agrotwin.env
sudo chown root:agrotwin /etc/agrotwin/agrotwin.env && sudo chmod 640 /etc/agrotwin/agrotwin.env
sudo nano /etc/agrotwin/agrotwin.env      # the address, mail server, …
```

## 4. Backend (Python) and frontend (web app)

```bash
sudo -u agrotwin bash -c '
  cd /opt/agrotwin
  python3.12 -m venv venv
  venv/bin/pip install --upgrade pip
  venv/bin/pip install -r backend/requirements.txt
  # the CUDA build of PyTorch that matches the driver — see pytorch.org, e.g.:
  venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cu124
  venv/bin/python -c "import torch; print(\"GPU:\", torch.cuda.is_available())"

  cd frontend
  npm ci
  # map sources are chosen at build time: NEXT_PUBLIC_TERRAIN=ellipsoid avoids the
  # Esri terrain service (it needs an ArcGIS licence for commercial use)
  NEXT_PUBLIC_TERRAIN=ellipsoid npm run build
'
```

## 5. OpenDroneMap and the assistant

```bash
sudo -u agrotwin docker pull opendronemap/odm:gpu

curl -fsSL https://ollama.com/install.sh | sh     # installs and starts ollama.service on 127.0.0.1:11434
ollama pull qwen2.5:14b-instruct-q4_K_M            # a GPU with < 16 GB: qwen2.5:7b-instruct, and set AGROTWIN_OLLAMA_MODEL
```

Without Ollama the assistant still answers, built straight from the
measurements. Without Docker/ODM (`AGROTWIN_ODM_ENABLED=false`) farmers get
the quick map only.

## 6. Services

```bash
sudo cp /opt/agrotwin/deploy/systemd/agrotwin-*.service /opt/agrotwin/deploy/systemd/agrotwin-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now agrotwin-api agrotwin-web agrotwin-backup.timer
systemctl status agrotwin-api agrotwin-web
curl -s http://127.0.0.1:8000/api/health
```

## 7. nginx and https

```bash
sudo cp /opt/agrotwin/deploy/nginx/agrotwin-proxy.conf /etc/nginx/
sudo cp /opt/agrotwin/deploy/nginx/agrotwin.conf /etc/nginx/sites-available/agrotwin
sudo sed -i 's/agrotwin.example.edu/YOUR.DNS.NAME/g' /etc/nginx/sites-available/agrotwin
sudo ln -s /etc/nginx/sites-available/agrotwin /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
# first certificate: comment out the "listen 443" server block, reload, then
sudo certbot certonly --webroot -w /var/www/html -d YOUR.DNS.NAME
# put the 443 block back:
sudo nginx -t && sudo systemctl reload nginx
```

nginx serves the map tiles and 3D files straight from
`/opt/agrotwin/frontend/public/{tiles,models,splats}`, asking the API before
each one whether the signed-in user may see that field — farmers never see
each other's maps. (Those folders can be moved to the data disk and replaced
by symlinks.)

## 8. The first admin

```bash
sudo -u agrotwin bash -c 'set -a; . /etc/agrotwin/agrotwin.env; cd /opt/agrotwin/backend;
  ../venv/bin/python -m scripts.create_user --email you@example.edu --name "Your Name" --role admin'
```

Then open `https://YOUR.DNS.NAME`, sign in, and create the farmers' accounts
on the **Users** page. Each farmer gets an e-mail address and a temporary
password to change under Settings.

## Day to day

| | |
|---|---|
| Logs | `journalctl -u agrotwin-api -f`, `journalctl -u agrotwin-web -f` |
| A detailed map's OpenDroneMap output | `/srv/agrotwin/data/surveys/<flight id>/odm/agrotwin_odm.log` |
| Running jobs | a flight's page shows its progress; staff also see why a job failed |
| Database backup | nightly at 02:30 to `/srv/agrotwin/backups` (14 days kept); back up `/srv/agrotwin/data` with the university's file backup |
| Restart | `sudo systemctl restart agrotwin-api agrotwin-web` — a quick map in progress is marked failed (the farmer presses Try again); a detailed map resumes by itself |

### Updating

```bash
sudo -u agrotwin bash -c '
  cd /opt/agrotwin && git pull
  venv/bin/pip install -r backend/requirements.txt
  cd frontend && npm ci && NEXT_PUBLIC_TERRAIN=ellipsoid npm run build
'
sudo systemctl restart agrotwin-api agrotwin-web
```

### Moving existing data from a laptop

Copy the laptop's `data/` folder to `/srv/agrotwin/data`, and its
`frontend/public/{tiles,models,splats}` folders to the same places under
`/opt/agrotwin/frontend/public/`. Then let the database point at the new
locations and start the services:

```bash
sudo -u agrotwin bash -c 'set -a; . /etc/agrotwin/agrotwin.env; cd /opt/agrotwin/backend; ../venv/bin/python -m scripts.relocate_paths'
```
