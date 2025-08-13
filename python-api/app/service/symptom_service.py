import logging
from typing import Optional

from app.domain.symptom import FrequencyLevel, SeverityLevel, Symptom
from app.service.llm_service import LLMService


LOG = logging.getLogger(__name__)


class SymptomService:
    """Service for managing disease symptoms using LLM generation."""

    def __init__(self, llm_service: LLMService):
        """Initialize with optional LLM service dependency."""
        self._llm_service = llm_service

    def _create_symptom_prompt(self, disease_name: str) -> str:
        """Create a structured prompt for symptom generation."""
        return f"""You are a medical expert AI. Given a disease name, provide a comprehensive list of symptoms commonly associated with this disease.

Disease: {disease_name}

Please respond with a JSON object containing an array of symptoms. Each symptom should have the following structure:
{{
    "name": "symptom name",
    "medical_name": "medical term for the symptom",
    "description": "brief description of the symptom",
    "severity": "mild|moderate|severe",
    "frequency": "rare|uncommon|common|very_common",
}}

Requirements:
- Include characteristic symptoms but also rare ones
- Be medically accurate
- Use standard medical terminology
- Focus on symptoms that are diagnostically relevant
- Only include the JSON response, no additional text

Response format:
{{
    "symptoms": [
        // array of symptom objects
    ]
}}"""

    async def generate_symptoms(self, disease_name: str) -> list[Symptom]:
        """Generate symptoms for a given disease using LLM."""
        try:
            prompt = self._create_symptom_prompt(disease_name)

            async with self._llm_service as llm_service:
                # Check if service is available
                if not await llm_service.health_check():
                    raise Exception(
                        "LLM service is not available. Please ensure Ollama is running."
                    )

                symptom_data = await self._llm_service.generate_json(prompt)

                symptoms = []
                for symptom_dict in symptom_data.get("symptoms", []):
                    try:
                        symptom = Symptom.from_dict(symptom_dict)
                        symptoms.append(symptom)
                    except Exception as e:
                        LOG.warning(
                            f"Failed to parse symptom: {symptom_dict}, error: {e}"
                        )
                        continue

                return symptoms
        except Exception as e:
            LOG.error(f"Unexpected error generating symptoms: {e}")
            raise Exception(f"Failed to generate symptoms: {e}")

    async def get_disease_symptoms(self, disease_name: str) -> list[Symptom]:
        """Get symptoms for a given disease using LLM generation."""

        if not disease_name or not disease_name.strip():
            raise ValueError("Disease name cannot be empty")

        disease_name = disease_name.strip()
        LOG.info(f"Generating symptoms for disease: {disease_name}")

        symptoms_result = await self.generate_symptoms(disease_name)
        LOG.info(f"Generated {len(symptoms_result)} symptoms for {disease_name}")

        return symptoms_result
