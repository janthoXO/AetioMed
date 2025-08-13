import logging

from fastapi import FastAPI

from app.rest.router import api_router
from app.utils.settings import settings

logging.basicConfig(level=settings.log_level)
app = FastAPI()
app.include_router(api_router)
