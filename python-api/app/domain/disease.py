from pydantic import BaseModel, Field

class Disease(BaseModel):
    """Represents a medical disease with its characteristics."""
    
    name: str = Field(..., description="The name of the disease")