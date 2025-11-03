package main

import (
	"encoding/json"
	"fmt"
	"os"

	log "github.com/sirupsen/logrus"
)

func main() {
	// Load environment variables
	LoadConfig()

	// Initialize MySQL database
	if err := InitDB(); err != nil {
		log.WithError(err).Warn("Failed to initialize database")
	}
	defer CloseDB()

	result, err := FetchSemType()
	if err != nil {
		log.WithError(err).Error("Failed to query")
		return
	}
	json, _ := json.MarshalIndent(result, "", "  ")

	// Write JSON to a file
	err = os.WriteFile("semtypes.example.json", json, 0644)
	if err != nil {
		log.WithError(err).Error("Failed to write result to file")
	}
}

func FetchSymptoms(icd string) ([]map[string]string, error) {
	if DB == nil {
		log.Error("Database not connected")
		return nil, nil
	}

	// SQL query to find symptoms related to a disease by ICD code
	query, err := DB.Prepare(`
	WITH RECURSIVE
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
    recursive_relations AS (
        -- Anchor: direct relations (distance 1)
        SELECT
            rel.CUI2 AS cui,
            1 AS distance
        FROM disease
        JOIN MRREL rel ON disease.CUI = rel.CUI1
        UNION
        SELECT
            rel.CUI1 AS cui,
            1 AS distance
        FROM disease
        JOIN MRREL rel ON disease.CUI = rel.CUI2
        -- Recursive: expand to further distances
        UNION ALL
        SELECT
            rel.CUI2 AS cui,
            recursive_relations.distance + 1 AS distance
        FROM recursive_relations
        JOIN MRREL rel ON recursive_relations.cui = rel.CUI1
        WHERE recursive_relations.distance < 2
        UNION ALL
        SELECT
            rel.CUI1 AS cui,
            recursive_relations.distance + 1 AS distance
        FROM recursive_relations
        JOIN MRREL rel ON recursive_relations.cui = rel.CUI2
        WHERE recursive_relations.distance < 2
    ),
    symptomCUIs AS (
        SELECT DISTINCT recursive_relations.cui, distance
        FROM recursive_relations
        JOIN MRSTY semtype ON recursive_relations.cui = semtype.CUI
        WHERE semtype.TUI = 'T184' -- T184 = Sign or Symptom
    ),
    symptoms AS (
        SELECT DISTINCT
            MRCONSO.CUI AS cui,
            ANY_VALUE(MRCONSO.STR) AS STR,
            MIN(symptomCUIs.distance) AS distance
        FROM MRCONSO
        JOIN symptomCUIs ON MRCONSO.CUI = symptomCUIs.cui
        WHERE MRCONSO.LAT = 'ENG'
        GROUP BY MRCONSO.CUI
    )
SELECT DISTINCT
    symptoms.CUI,
    ANY_VALUE(symptoms.STR) AS STR,
    ANY_VALUE(def.DEF) AS DEF,
    ANY_VALUE(symptoms.distance) AS distance
FROM symptoms
LEFT JOIN MRDEF def ON symptoms.CUI = def.CUI
WHERE def.SAB = 'MSH'
GROUP BY symptoms.CUI
	`)
	if err != nil {
		log.WithError(err).Error("Failed to prepare query for symptoms")
		return nil, err
	}
	defer query.Close()

	log.Info("Starting Query")
	rows, err := query.Query(icd)
	if err != nil {
		log.WithError(err).Errorf("Failed to query symptoms for ICD code: %s", icd)
		return nil, err
	}
	defer rows.Close()

	var results []map[string]string
	for rows.Next() {
		var cui, str string
		var def *string // Use pointer for nullable field
		var distance int

		if err := rows.Scan(&cui, &str, &def, &distance); err != nil {
			log.WithError(err).Error("Failed to scan symptom row")
			continue
		}

		results = append(results, map[string]string{
			"cui": cui,
			"str": str,
			"def": func() string {
				if def != nil {
					return *def
				}
				return ""
			}(),
			"distance": fmt.Sprintf("%d", distance),
		})
	}

	if err := rows.Err(); err != nil {
		log.WithError(err).Error("Error occurred during row iteration")
		return nil, err
	}

	log.Debugf("Found %d symptoms for ICD code: %s", len(results), icd)
	return results, nil
}

func FetchSemType() ([]map[string]string, error) {
	if DB == nil {
		log.Error("Database not connected")
		return nil, nil
	}

	query, err := DB.Prepare(`
	SELECT DISTINCT semtype.TUI, semtype.STY
FROM MRSTY semtype
ORDER BY semtype.TUI
LIMIT 300
	`)
	if err != nil {
		log.WithError(err).Error("Failed to prepare query for semtypes")
		return nil, err
	}
	defer query.Close()

	log.Info("Starting Query")
	rows, err := query.Query()
	if err != nil {
		log.WithError(err).Errorf("Failed to query semtypes")
		return nil, err
	}
	defer rows.Close()

	var results []map[string]string
	for rows.Next() {
		var tui, sty string

		if err := rows.Scan(&tui, &sty); err != nil {
			log.WithError(err).Error("Failed to scan semtype row")
			continue
		}

		results = append(results, map[string]string{
			"tui": tui,
			"sty": sty,
		})
	}

	if err := rows.Err(); err != nil {
		log.WithError(err).Error("Error occurred during row iteration")
		return nil, err
	}

	log.Debugf("Found %d semtypes", len(results))
	return results, nil
}
