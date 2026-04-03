type Config = {
  serverUrl: string;
  language: string;
};

export const config: Config = {
  serverUrl: import.meta.env.VITE_SERVER_URL || "http://localhost:3030/api",
  language: import.meta.env.VITE_LANGUAGE || "English",
};
