package utils

import (
	"github.com/caarlos0/env/v11"
	"github.com/joho/godotenv"
	log "github.com/sirupsen/logrus"
)

type Configuration struct {
	Server struct {
		Port int `env:"SERVER_PORT" envDefault:"3030"`
	}
	DiseaseMiddleware struct {
		Url string `env:"DISEASE_MIDDLEWARE_URL" envDefault:"http://localhost:3031"`
	}
	OllamaApi struct {
		Url   string `env:"OLLAMA_URL" envDefault:"http://localhost:11434"`
		Model string `env:"OLLAMA_MODEL_NAME" envDefault:"hf.co/mradermacher/JSL-MedQwen-14b-reasoning-i1-GGUF:Q4_K_S"`
	}
	Debug bool `env:"DEBUG" envDefault:"false"`
}

var (
	Cfg Configuration
)

func LoadConfig() Configuration {
	err := godotenv.Load(".env")
	if err != nil {
		log.WithError(err).Warn("Error loading .env file")
	}

	err = env.Parse(&Cfg)
	if err != nil {
		log.WithError(err).Fatal("Error parsing environment variables")
	}

	if Cfg.Debug {
		log.SetLevel(log.DebugLevel)
		log.Warn("DEBUG MODE ENABLED")
	}

	return Cfg
}
