import json
import logging
from typing import List
import httpx
from pydantic import BaseModel
from app.utils.settings import settings

LOG = logging.getLogger(__name__)


class LLMConfig(BaseModel):
    """Configuration for LLM model."""

    base_url: str
    model_name: str
    temperature: float
    timeout: int


class LLMService:
    """Service for interacting with Ollama LLM."""

    def __init__(self):
        self.config = LLMConfig(
            base_url=settings.ollama_base_url,
            model_name=settings.ollama_model_name,
            temperature=settings.ollama_temperature,
            timeout=settings.ollama_timeout,
        )
        self.client = httpx.AsyncClient(timeout=None)

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        await self.client.aclose()

    async def generate(self, prompt: str) -> str:
        """Generate raw text for a given prompt using LLM."""

        try:
            payload = {
                "model": self.config.model_name,
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": self.config.temperature},
            }

            LOG.info(f"Requesting generation")
            LOG.info(f"Using Ollama at: {self.config.base_url}")
            LOG.info(f"Using model: {self.config.model_name}")

            response = await self.client.post(
                f"{self.config.base_url}/api/generate", json=payload
            )
            response.raise_for_status()

            result = response.json()
            llm_response = result.get("response", "")

            LOG.debug(f"LLM raw response: {llm_response}")

            return llm_response

        except httpx.ConnectError as e:
            LOG.error(f"Connection error to Ollama at {self.config.base_url}: {e}")
            raise Exception(
                f"Cannot connect to Ollama service at {self.config.base_url}. Please ensure Ollama is running."
            )
        except httpx.TimeoutException as e:
            LOG.error(f"Timeout error when calling Ollama: {e}")
            raise Exception(
                f"Timeout connecting to Ollama service (timeout: {self.config.timeout}s). Model might be loading or overloaded."
            )
        except httpx.HTTPError as e:
            LOG.error(f"HTTP error when calling Ollama at {self.config.base_url}: {e}")
            raise Exception(
                f"Failed to connect to Ollama service at {self.config.base_url}: {e}"
            )
        except Exception as e:
            LOG.error(f"Unexpected error generating llm: {e}")
            raise Exception(f"Failed to generate llm: {e}")

    async def generate_json(self, prompt: str) -> dict:
        """Generate json for a given prompt using LLM."""

        llm_response = await self.generate(prompt)

        # Parse the JSON response
        try:
            # Try to extract JSON from the response
            json_start = llm_response.find("{")
            json_end = llm_response.rfind("}") + 1

            if json_start != -1 and json_end > json_start:
                json_str = llm_response[json_start:json_end]
                json_data = json.loads(json_str)
            else:
                # Fallback: try to parse the entire response as JSON
                json_data = json.loads(llm_response)

            return json_data

        except json.JSONDecodeError as e:
            LOG.error(f"Failed to parse LLM JSON response: {e}")
            raise ValueError("Failed to parse LLM JSON response")

    async def health_check(self) -> bool:
        """Check if Ollama service is available."""
        try:
            response = await self.client.get(f"{self.config.base_url}/api/tags")
            return response.status_code == 200
        except Exception:
            return False
