package service

import (
	"context"
	"disease-middleware/db"
	"disease-middleware/models"

	log "github.com/sirupsen/logrus"
)

type UmlsDbService struct{}

// Ensure UmlsDbService implements SymptomService interface
var _ SymptomService = (*UmlsDbService)(nil)

func (s *UmlsDbService) FetchSymptoms(ctx context.Context, icd string) ([]any, error) {
	// SQL query to find symptoms related to a disease by ICD code
	query := `
	WITH
		disease AS (
			SELECT *
			FROM MRCONSO
			WHERE
				CODE = ?
				AND SAB IN (
					'ICD10CM',
					'ICD10',
					'ICD10WHO'
				)
				AND LAT = 'ENG'
		),
		related AS (
			SELECT rel.*
			FROM disease
				JOIN MRREL rel ON disease.CUI = rel.CUI1
			UNION
			SELECT rel.*
			FROM disease
				JOIN MRREL rel ON disease.CUI = rel.CUI2
		),
		symptoms AS (
			SELECT DISTINCT
				sym.*
			FROM (
					SELECT s.*
					FROM related
						JOIN MRCONSO s ON related.CUI2 = s.CUI
					WHERE
						s.LAT = 'ENG'
					UNION
					SELECT s.*
					FROM related
						JOIN MRCONSO s ON related.CUI1 = s.CUI
					WHERE
						s.LAT = 'ENG'
				) sym
				JOIN MRSTY semtype ON sym.CUI = semtype.CUI
			WHERE
				semtype.TUI = 'T184'
		)
	SELECT DISTINCT symptoms.CUI, ANY_VALUE(symptoms.STR) AS STR, ANY_VALUE(def.DEF) AS DEF
	FROM symptoms
	LEFT JOIN MRDEF def ON symptoms.CUI = def.CUI
	GROUP BY symptoms.CUI`

	rows, err := db.DB.QueryContext(ctx, query, icd)
	if err != nil {
		log.WithError(err).Errorf("Failed to query symptoms for ICD code: %s", icd)
		return nil, err
	}
	defer rows.Close()

	var results []any
	for rows.Next() {
		var cui, str string
		var def *string // Use pointer for nullable field

		if err := rows.Scan(&cui, &str, &def); err != nil {
			log.WithError(err).Error("Failed to scan symptom row")
			continue
		}

		symptom := models.Symptom{
			Name:        str,
			Description: "",
		}

		// Set description if definition exists
		if def != nil {
			symptom.Description = *def
		}

		results = append(results, symptom)
	}

	if err := rows.Err(); err != nil {
		log.WithError(err).Error("Error occurred during row iteration")
		return nil, err
	}

	log.Infof("Found %d symptoms for ICD code: %s", len(results), icd)
	return results, nil
}
