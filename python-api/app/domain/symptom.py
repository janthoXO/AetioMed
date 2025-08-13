from pydantic import BaseModel, Field
from typing import List, Optional
from enum import Enum


class SeverityLevel(str, Enum):
    MILD = "mild"
    MODERATE = "moderate"
    SEVERE = "severe"


class FrequencyLevel(str, Enum):
    RARE = "rare"
    UNCOMMON = "uncommon"
    COMMON = "common"
    VERY_COMMON = "very_common"


class Symptom(BaseModel):
    """Represents a medical symptom with its characteristics."""

    name: str = Field(..., description="The name of the symptom")
    medical_name: str = Field(..., description="The medical term for the symptom")
    description: Optional[str] = Field(
        None, description="Detailed description of the symptom"
    )
    severity: Optional[SeverityLevel] = Field(
        None, description="Typical severity level of the symptom"
    )
    frequency: FrequencyLevel = Field(
        ..., description="How frequently this symptom occurs in the disease"
    )

    @classmethod
    def from_dict(cls, data: dict) -> "Symptom":
        # Validate and convert severity and frequency
        severity = None
        if data.get("severity"):
            try:
                severity = SeverityLevel(data["severity"].lower())
            except ValueError:
                severity = None

        frequency = FrequencyLevel.COMMON  # default
        if data.get("frequency"):
            try:
                frequency = FrequencyLevel(data["frequency"].lower())
            except ValueError:
                frequency = FrequencyLevel.COMMON

        return cls(
            name=data.get("name", ""),
            medical_name=data.get("medical_name", ""),
            description=data.get("description"),
            severity=severity,
            frequency=frequency,
        )
