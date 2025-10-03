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
	UmlsApi struct {
		Url    string `env:"UMLS_URL" envDefault:"https://uts-ws.nlm.nih.gov/rest"`
		ApiKey string `env:"UMLS_KEY,notEmpty"`
	}
	IcdApi struct {
		Url          string `env:"ICD_URL" envDefault:"https://icd.who.int"`
		TokenUrl     string `env:"ICD_TOKEN_URL" envDefault:"https://icdaccessmanagement.who.int/connect/token"`
		ClientId     string `env:"ICD_CLIENT_ID,notEmpty"`
		ClientSecret string `env:"ICD_CLIENT_SECRET,notEmpty"`
	}
	MeshApi struct {
		Url string `env:"MESH_URL" envDefault:"https://id.nlm.nih.gov/mesh/sparql"`
	}
	OllamaApi struct {
		Url   string `env:"OLLAMA_URL" envDefault:"http://localhost:11434"`
		Model string `env:"OLLAMA_MODEL_NAME" envDefault:"hf.co/mradermacher/JSL-MedQwen-14b-reasoning-i1-GGUF:Q4_K_S"`
	}
	Db struct {
		Url      string `env:"DB_URL" envDefault:"localhost:3306"`
		Name     string `env:"DB_NAME" envDefault:"umls"`
		User     string `env:"DB_USER" envDefault:"test"`
		Password string `env:"DB_PASSWORD" envDefault:"test"`
	}
	Cache struct {
		Url      string `env:"CACHE_URL" envDefault:"localhost:6379"`
		Password string `env:"CACHE_PASSWORD" envDefault:"test"`
		TTL_SEC  int    `env:"CACHE_TTL_SEC" envDefault:"86400"` // 1 day
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
