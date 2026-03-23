#!/bin/bash

MODEL="${MODEL_NAME:-llama3.1}"

# Start Ollama in the background.
/bin/ollama serve &
# Record Process ID.
pid=$!

# Pause for Ollama to start.
sleep 5

echo "🔴 Retrieve model..."
ollama pull "$MODEL"
echo "🟢 Done!"
# TODO pull embedding model

# Wait for Ollama process to finish.
wait $pid
