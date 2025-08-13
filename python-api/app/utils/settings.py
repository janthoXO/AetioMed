from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    log_level: str = Field(default="INFO")
    
    # LLM Configuration
    ollama_base_url: str = Field(default="http://localhost:11434")
    ollama_model_name: str = Field(default="hf.co/mradermacher/JSL-MedQwen-14b-reasoning-i1-GGUF:Q4_K_S")
    ollama_temperature: float = Field(default=0.3)
    ollama_timeout: int = Field(default=120)


settings = Settings()
