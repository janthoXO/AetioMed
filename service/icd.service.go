package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"disease-middleware/utils"
	"time"

	log "github.com/sirupsen/logrus"
)

type IcdService struct{}

func (s *IcdService) ServiceName() string {
	return "ICD API Service"
}

func (s *IcdService) FetchSymptoms(ctx context.Context, icd string) ([]any, error) {
	access_token, err := getOAuthToken(ctx)
	if err != nil {
		return nil, err
	}

	rawUrl := fmt.Sprintf("%s/icd/entity/search?q=%s&highlightingEnabled=false", utils.Cfg.IcdApi.Url, url.QueryEscape(icd))

	req, err := http.NewRequestWithContext(ctx, "GET", rawUrl, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+access_token)
	req.Header.Set("API-Version", "v2")
	req.Header.Set("Accept-Language", "en")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("Error searching icd: %s %s", resp.Status, body)
	}

	var data struct {
		DestinationEntities []struct {
			ID      string `json:"id"`
			Chapter string `json:"chapter"`
			Title   string `json:"title"`
			StemID  string `json:"stemId"`
		} `json:"destinationEntities"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return nil, err
	}

	url, err := url.Parse(data.DestinationEntities[0].ID)
	if err != nil {
		return nil, err
	}
	q := url.Query()
	q.Add("include", "diagnosticCriteria")
	url.RawQuery = q.Encode()

	req, err = http.NewRequestWithContext(ctx, "GET", url.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+access_token)
	req.Header.Set("API-Version", "v2")
	req.Header.Set("Accept-Language", "en")

	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("Error querying icd entity: %s %s", resp.Status, body)
	}

	var foundationEntity struct {
		DiagnosticCriteria []any `json:"diagnosticCriteria"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&foundationEntity); err != nil {
		return nil, err
	}

	if foundationEntity.DiagnosticCriteria == nil {
		foundationEntity.DiagnosticCriteria = []any{}
	}

	return foundationEntity.DiagnosticCriteria, nil
}

type OAuthResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int64  `json:"expires_in"`
	ExpiresAt   int64
}

var token OAuthResponse

func getOAuthToken(ctx context.Context) (string, error) {
	// check if token expires in the next 60 seconds
	if token.ExpiresAt > time.Now().Unix()+60 {
		return token.AccessToken, nil
	}

	tokenResp, err := fetchOAuthToken(ctx)
	if err != nil {
		return "", err
	}
	token = *tokenResp

	return token.AccessToken, nil
}

func fetchOAuthToken(ctx context.Context) (*OAuthResponse, error) {
	form := url.Values{}
	form.Set("grant_type", "client_credentials")
	form.Set("scope", "icdapi_access")

	req, err := http.NewRequestWithContext(ctx, "POST", utils.Cfg.IcdApi.TokenUrl, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	// Set Basic Auth header
	auth := utils.Cfg.IcdApi.ClientId + ":" + utils.Cfg.IcdApi.ClientSecret
	req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(auth)))

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to get token: %s", body)
	}

	var tokenResp OAuthResponse
	if err := json.NewDecoder(resp.Body).Decode(&tokenResp); err != nil {
		return nil, err
	}
	tokenResp.ExpiresAt = tokenResp.ExpiresIn + time.Now().Unix()

	log.Debugf("Fetched new OAuth token: %+v", tokenResp)

	return &tokenResp, nil
}
