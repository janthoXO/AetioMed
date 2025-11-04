package main

import (
	"case-generator/controller"
	natsservice "case-generator/nats"
	"case-generator/service"
	"case-generator/utils"
	"context"
	"fmt"

	"github.com/gin-gonic/gin"
	log "github.com/sirupsen/logrus"
)

func main() {
	// Load environment variables
	cfg := utils.LoadConfig()
	log.Infof("Loaded configuration: %+v", cfg.Server)

	llmService := service.GetLLMService()
	if !llmService.HealthCheck(context.Background()) {
		log.Warn("LLM Service is not available")
	}

	// Initialize NATS service
	var err error
	natsservice.NatsServiceInstance, err = natsservice.NewNatsService()
	if err != nil {
		log.Fatalf("Failed to initialize NATS service: %v", err)
	}
	defer natsservice.NatsServiceInstance.Close()
	natsservice.NatsServiceInstance.InitializeStream("cases")

	// Register NATS handlers
	natsHandlers := []controller.NatsHandler{
		controller.NewCaseNatsHandler(),
	}
	for _, natsHandler := range natsHandlers {
		err := natsHandler.RegisterHandler()
		if err != nil {
			log.Fatalf("Failed to register NATS handler: %v", err)
		}
	}

	log.Infof("Starting Case Generator on port %d", cfg.Server.Port)
	gin.SetMode(gin.ReleaseMode)

	r := SetupRouter()
	log.Panic(r.Run(fmt.Sprintf(":%d", cfg.Server.Port)))
}
