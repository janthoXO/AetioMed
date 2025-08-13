# Symptom Generation API

This API generates symptoms for diseases using LLM (Large Language Model) through Ollama.

## Setup

### 1. Install Ollama

```bash
# Install Ollama (macOS)
brew install ollama

# Or download from https://ollama.ai
```

### 2. Pull the Medical Model

```bash
# Pull the medical model
ollama pull hf.co/mradermacher/JSL-MedQwen-14b-reasoning-i1-GGUF:Q4_K_S
```

### 3. Start Ollama Service

```bash
ollama serve
```

### 4. Install Python Dependencies

```bash
pip install -r requirements.txt
```

### 5. Run the API

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

## API Endpoints

### Get Disease Symptoms

```http
GET /diseases/{disease_name}/symptoms
```

**Example:**

```bash
curl "http://localhost:8000/diseases/diabetes/symptoms"
```

**Response:**

```json
[
  {
    "name": "Polyuria",
    "description": "Frequent urination",
    "severity": "moderate",
    "frequency": "very_common",
    "body_system": "urinary"
  },
  {
    "name": "Polydipsia",
    "description": "Excessive thirst",
    "severity": "moderate",
    "frequency": "very_common",
    "body_system": "endocrine"
  }
]
```

## Environment Configuration

Create a `.env` file to customize settings:

```env
# Ollama Configuration
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL_NAME=mradermacher/JSL-MedQwen-14b-reasoning-i1-GGUF
OLLAMA_TEMPERATURE=0.3
OLLAMA_TIMEOUT=60

# Logging
LOG_LEVEL=INFO
```

## Model Swapping

To use a different model, simply change the `OLLAMA_MODEL_NAME` in your `.env` file:

```env
# For a smaller, faster model (less medical accuracy)
OLLAMA_MODEL_NAME=llama3.2:3b

# For the recommended medical model
OLLAMA_MODEL_NAME=mradermacher/JSL-MedQwen-14b-reasoning-i1-GGUF
```

## Architecture

- **Domain Models**: `app/domain/symptom.py` - Pydantic models for structured data
- **LLM Service**: `app/service/llm_service.py` - Modular Ollama integration
- **Symptom Service**: `app/service/symptom_service.py` - Business logic layer
- **REST Controllers**: `app/rest/` - FastAPI endpoints
- **Settings**: `app/utils/settings.py` - Configuration management

## Error Handling

The API handles various error scenarios:

- Invalid disease names (400 Bad Request)
- LLM service unavailable (500 Internal Server Error)
- JSON parsing errors from LLM responses
- Network timeouts and connection issues

## Testing

Test with different disease names:

```bash
curl "http://localhost:8000/diseases/hypertension/symptoms"
curl "http://localhost:8000/diseases/pneumonia/symptoms"
curl "http://localhost:8000/diseases/migraine/symptoms"
```
