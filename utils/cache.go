package utils

import (
	"context"
	"encoding/json"
	"time"

	"github.com/go-redis/redis/v8"
	log "github.com/sirupsen/logrus"
)

var (
	CacheInstance cache
)

type cache struct {
	redisClient *redis.Client
}

// Initialize the Redis client
func InitCache() {
	CacheInstance = cache{}
	CacheInstance.redisClient = redis.NewClient(&redis.Options{
		Addr:     Cfg.Cache.Url,      // Redis server address
		Password: Cfg.Cache.Password, // No password set
		DB:       0,                  // Use default DB
	})

	// Test connection
	ctx := context.Background()
	if err := CacheInstance.redisClient.Ping(ctx).Err(); err != nil {
		log.WithError(err).Warn("Failed to connect to Cache Redis")
	} else {
		log.Info("Connected to Cache Redis successfully")
	}
}

func (c *cache) Get(key string, value any) error {
	ctx := context.Background()
	data, err := c.redisClient.Get(ctx, key).Bytes()
	if err != nil {
		return err
	}

	if err := json.Unmarshal(data, value); err != nil {
		return err
	}

	return nil
}

func (c *cache) Set(key string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}

	ctx := context.Background()
	return c.redisClient.Set(ctx, key, data, time.Duration(Cfg.Cache.TTL_SEC)*time.Second).Err()
}
