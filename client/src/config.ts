type Config = {
  generationUrl: string;
  fetchUrl: string;
  language: string;
};

export const config: Config = {
  generationUrl:
    import.meta.env.VITE_GENERATION_URL || "http://localhost:3030/api/cases",
  fetchUrl: import.meta.env.VITE_FETCH_URL || "http://localhost:3030/api/cases",
  language: import.meta.env.VITE_LANGUAGE || "English",
};
