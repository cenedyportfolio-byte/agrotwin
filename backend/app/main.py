import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import init_db
from app.routers import analysis, auth, fields, health, queue, surveys, users
from app.services import job_runner

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

app = FastAPI(title=settings.app_name)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(auth.router)
app.include_router(users.router)
app.include_router(fields.router)
app.include_router(surveys.router)
app.include_router(analysis.router)
app.include_router(queue.router)


@app.on_event("shutdown")
def on_shutdown():
    job_runner.stop()


@app.on_event("startup")
def on_startup():
    init_db()
    interrupted = job_runner.recover_interrupted_jobs()
    if interrupted:
        logging.getLogger(__name__).warning("marked %d interrupted processing job(s) as failed", interrupted)
