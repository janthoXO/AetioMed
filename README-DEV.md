# AetioMed - Developer Guide

This document provides technical details for setting up, running, and contributing to the AetioMed project.

## Tech Stack

- **Runtime**: Node.js
- **Language**: TypeScript
- **Framework**: Express.js
- **Message Broker**: NATS (JetStream)
- **AI/LLM**: Ollama (running local models), LangChain, LangGraph
- **Package Manager**: pnpm

## Prerequisites

Ensure you have the following installed:

- [Node.js](https://nodejs.org/) (v20 or higher recommended)
- [pnpm](https://pnpm.io/) (`npm install -g pnpm`)
- [Docker](https://www.docker.com/) & Docker Compose

## Getting Started

### 1. Installation

Clone the repository and install dependencies:

```bash
git clone <repository-url>
cd AetioMed
pnpm install
```

### 2. Environment Configuration

The application relies on several environment variables. You can set these in a `.env` file in the root directory or let them default (see `docker-compose.yml` for defaults).

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3030` | The port the REST server listens on. |
| `DEBUG` | `true` | Enables verbose logging (Morgan). |
| `LLM_FORMAT` | `JSON` | Format for LLM responses. |
| `NATS_URL` | `nats://nats:4222` | URL for the NATS server. |
| `NATS_USER` | `nats` | NATS username. |
| `NATS_PASSWORD` | `nats` | NATS password. |

### 3. Running the Application

#### Option A: Docker (Recommended)

The easiest way to run the full stack (Server, NATS, Ollama) is via Docker Compose.

```bash
docker compose up --build
```

This will:
1. Start a NATS server.
2. Start an Ollama instance and automatically pull the required medical LLM (`JSL-MedQwen-14b-reasoning`).
3. Build and start the AetioMed server.

The server will be available at `http://localhost:3030`.

#### Option B: Local Development

If you want to run the Node.js server locally for development while keeping infrastructure in Docker:

1. **Start Infrastructure (NATS & Ollama):**
   ```bash
   docker compose up -d nats ollama
   ```
   *Note: On the first run, the Ollama container might take a while to pull the large medical model (approx. 8-10GB).*

2. **Run Server:**
   ```bash
   pnpm dev
   ```
   This uses `tsx watch` to auto-restart on file changes.

## API Documentation

When the server is running, you can access the Swagger UI documentation at:

```
http://localhost:3030/api/docs
```

The base API path is `/api`.

## Testing & Verification

- **Linting:**
  ```bash
  pnpm lint
  ```
- **Graph Testing:**
  To test the case generation logic (LangGraph pipelines):
  ```bash
  pnpm graph:test
  ```

## Architecture Overview

The application is structured into several key components:

- **`src/rest`**: Express API routes and Swagger configuration.
- **`src/nats`**: NATS client, publishers, and subscribers (handlers). NATS is used for asynchronous tasks like triggering case generation.
- **`src/graph`**: Contains the core logic for AI generation using **LangGraph**.
  - **Draft**: Initial case creation.
  - **Council**: Reviews the case.
  - **Consistency**: Final checks.
- **`src/domain-models`**: TypeScript interfaces and classes defining the data structure (e.g., `Anamnesis`, `Case`).

## Additional Tools

- **Bruno**: API collection files are provided in the `docs/bruno` folder for testing endpoints.
- **Swagger**: `pnpm swagger` regenerates the `swagger-output.json` file.
