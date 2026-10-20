UPDATE `translation` SET `lang` = CASE `lang`
  WHEN 'English' THEN 'en' WHEN 'German' THEN 'de' WHEN 'French' THEN 'fr' WHEN 'Spanish' THEN 'es'
  WHEN 'Italian' THEN 'it' WHEN 'Portuguese' THEN 'pt' WHEN 'Dutch' THEN 'nl' WHEN 'Polish' THEN 'pl'
  WHEN 'Russian' THEN 'ru' WHEN 'Ukrainian' THEN 'uk' WHEN 'Turkish' THEN 'tr' WHEN 'Arabic' THEN 'ar'
  WHEN 'Chinese' THEN 'zh' WHEN 'Japanese' THEN 'ja' WHEN 'Korean' THEN 'ko' WHEN 'Swedish' THEN 'sv'
  WHEN 'Danish' THEN 'da' WHEN 'Norwegian' THEN 'no' WHEN 'Finnish' THEN 'fi' WHEN 'Czech' THEN 'cs'
  WHEN 'Slovak' THEN 'sk' WHEN 'Romanian' THEN 'ro' WHEN 'Hungarian' THEN 'hu' WHEN 'Greek' THEN 'el'
  WHEN 'Bulgarian' THEN 'bg' WHEN 'Croatian' THEN 'hr' ELSE `lang` END;
