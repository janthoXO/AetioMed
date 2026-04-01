type Config = {
  generationUrl: string;
  fetchUrl: string;
  featuresUrl: string;
  language: string;
};

export const config: Config = {
  generationUrl:
    import.meta.env.VITE_GENERATION_URL || "http://localhost:3030/api/cases",
  fetchUrl: import.meta.env.VITE_FETCH_URL || "http://localhost:3030/api/cases",
  featuresUrl:
    import.meta.env.VITE_FEATURES_URL || "http://localhost:3030/api/features",
  language: import.meta.env.VITE_LANGUAGE || "English",
};
