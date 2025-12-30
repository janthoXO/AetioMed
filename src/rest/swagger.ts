import swaggerAutogen from "swagger-autogen";

const doc = {
  info: {
    title: "AetioMed API",
    description: "API Documentation",
  },
  host: "localhost:8080",
  tags: [
    {
      name: "Cases",
      description: "Cases endpoints",
    },
  ],
};

const outputFile = "./swagger-output.json";
const routes = ["../main.ts"]; // your main file

swaggerAutogen()(outputFile, routes, doc);
