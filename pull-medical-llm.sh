#!/bin/bash

MODEL="${MODEL_NAME:-hf.co/mradermacher/JSL-MedQwen-14b-reasoning-i1-GGUF:Q4_K_S}"

# Start Ollama in the background.
/bin/ollama serve &
# Record Process ID.
pid=$!

# Pause for Ollama to start.
sleep 5

echo "🔴 Retrieve model..."
ollama pull "$MODEL"
echo "🟢 Done!"

# Wait for Ollama process to finish.
wait $pid
