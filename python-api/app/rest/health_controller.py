import logging
from fastapi import APIRouter, Depends
from typing import Annotated

from app.service.symptom_service import SymptomService
from app.service.llm_service import LLMConfig, LLMService
from app.utils.settings import settings


LOG = logging.getLogger(__name__)
health_router = APIRouter(prefix="/health")

@health_router.get("", description="Check API health status")
async def health_check():
    """Basic health check for the API."""
    return {"status": "healthy", "service": "disease-api"}
