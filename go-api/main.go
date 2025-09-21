package main

import (
	"disease-middleware/db"
	"disease-middleware/utils"
	"fmt"

	"github.com/gin-gonic/gin"
	log "github.com/sirupsen/logrus"
)

func main() {
	// Load environment variables
	cfg := utils.LoadConfig()
	log.Infof("Loaded configuration: %+v", cfg.Server)

	// Initialize Redis client
	utils.InitCache()

	// Initialize MySQL database
	if err := db.InitDB(); err != nil {
		log.WithError(err).Fatal("Failed to initialize database")
	}
	defer db.CloseDB()

	log.Infof("Starting Symptom Middleware on port %d", cfg.Server.Port)
	gin.SetMode(gin.ReleaseMode)

	r := SetupRouter()
	log.Panic(r.Run(fmt.Sprintf(":%d", cfg.Server.Port)))
}
