import {
  PredefinedProcedures,
  type Procedure,
} from "@/02domain-models/Procedure.js";
import { MemoryVectorStore } from "@langchain/classic/vectorstores/memory";
import { Document } from "@langchain/core/documents";
import { getEmbeddings } from "@/utils/llm.js";

export class NoPredefinedProceduresError extends Error {
  constructor(message: string = "No predefined procedures available") {
    super(message);
  }
}

let vectorStore: MemoryVectorStore | null = null;

/**
 * Initializes the vector store by embedding all predefined procedures.
 * Must be called once at startup before searching.
 */
export async function initProcedureVectorStore(): Promise<void> {
  if (!PredefinedProcedures || PredefinedProcedures.length === 0) {
    console.warn("[VectorStore] No predefined procedures to index.");
    return;
  }

  const embeddings = getEmbeddings();
  const docs = PredefinedProcedures.map(
    (p) =>
      new Document({
        pageContent: p.name,
        metadata: { name: p.name },
      })
  );

  console.info(`[VectorStore] Indexing ${docs.length} predefined procedures...`);
  vectorStore = await MemoryVectorStore.fromDocuments(docs, embeddings);
  console.info(
    `[VectorStore] Indexed ${PredefinedProcedures.length} procedures.`
  );
}

const TOP_K = 3; // Number of top similar procedures to return

/**
 * Searches for the top-K most similar procedures using vector similarity.
 */
export async function searchForProcedures(query: string): Promise<Procedure[]> {
  if (!vectorStore) {
    throw new NoPredefinedProceduresError();
  }

  const results = await vectorStore.similaritySearch(
    query,
    TOP_K
  );
  return results.map((doc) => ({ name: doc.metadata.name as string }));
}
