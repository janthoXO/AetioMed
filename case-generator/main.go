package main

import (
	"case-generator/controller"
	"case-generator/nats"
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
	nats.NatsServiceInstance, err = nats.NewNatsService()
	if err != nil {
		log.Fatalf("Failed to initialize NATS service: %v", err)
	}
	defer nats.NatsServiceInstance.Close()
	nats.NatsServiceInstance.InitializeStream("cases")

	// Register NATS handlers
	natsHandlers := controller.NewNatsHandlers()
	if err := natsHandlers.RegisterHandlers(); err != nil {
		log.Fatalf("Failed to register NATS handlers: %v", err)
	}

	log.Infof("Starting Case Generator on port %d", cfg.Server.Port)
	gin.SetMode(gin.ReleaseMode)

	r := SetupRouter()
	log.Panic(r.Run(fmt.Sprintf(":%d", cfg.Server.Port)))
}
