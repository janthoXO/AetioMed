from fastapi import APIRouter

from app.rest.health_controller import health_router
from app.rest.disease_controller import disease_router

api_router = APIRouter(prefix="")
api_router.include_router(health_router)
api_router.include_router(disease_router)
