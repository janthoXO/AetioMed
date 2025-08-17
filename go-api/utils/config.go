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
		Url    string `env:"ICD_URL" envDefault:"https://icd.who.int"`
		TokenUrl string `env:"ICD_TOKEN_URL" envDefault:"https://icdaccessmanagement.who.int/connect/token"`
		ClientId string `env:"ICD_CLIENT_ID,notEmpty"`
		ClientSecret string `env:"ICD_CLIENT_SECRET,notEmpty"`
	}
	MeshApi struct {
		Url string `env:"MESH_URL" envDefault:"https://id.nlm.nih.gov/mesh/sparql"`
	}
	Cache struct {
		Url      string `env:"CACHE_URL,notEmpty"`
		Password string `env:"CACHE_PASSWORD,notEmpty"`
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
