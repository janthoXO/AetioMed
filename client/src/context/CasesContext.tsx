/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Case } from "@/models/Case";
import type { CaseGenerationRequest } from "@/api/dto/case-generation-request";
import { config } from "@/config";
import { db } from "@/db/db";
import * as casesApi from "@/api/cases.api";

export type CasesContextType = {
  cases: Case[];
  isLoading: boolean;
  generateCase: (request: CaseGenerationRequest) => Promise<string>;
  getCase: (id: string) => Case | undefined;
  deleteCase: (id: string) => Promise<void>;
};

export const CasesContext = createContext<CasesContextType | null>(null);

export function CasesProvider({ children }: { children: ReactNode }) {
  const [cases, setCases] = useState<Case[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Load cases on mount: try server first, fallback to IndexedDB
  useEffect(() => {
    async function loadCases() {
      try {
        const serverCases = await casesApi.fetchCases();

        if (serverCases && serverCases.length > 0) {
          // Upsert server cases into IndexedDB
          await db.cases.bulkPut(serverCases);

          const now = new Date();
          setCases(
            serverCases.sort(
              (a, b) =>
                new Date(b.createdAt ?? now).getTime() -
                new Date(a.createdAt ?? now).getTime()
            )
          );
        } else {
          // Fallback to IndexedDB
          const localCases = await db.cases
            .orderBy("createdAt")
            .reverse()
            .toArray();
          setCases(localCases);
        }
      } catch {
        // On any error, fallback to IndexedDB
        const localCases = await db.cases
          .orderBy("createdAt")
          .reverse()
          .toArray();
        setCases(localCases);
      } finally {
        setIsLoading(false);
      }
    }

    loadCases();
  }, []);

  const generateCase = useCallback(
    async (request: CaseGenerationRequest): Promise<string> => {
      const caseId = crypto.randomUUID();

      // 1. Create a placeholder case with input params
      const placeholderCase: Case = {
        id: caseId,
        diagnosis: {
          name: request.diagnosis,
          icd: request.icd,
        },
        generationFlags: request.generationFlags,
        language: request.language ?? config.language,
      };

      // 2. Add placeholder to context array immediately (shows skeleton in sidebar)
      setCases((prev) => [placeholderCase, ...prev]);

      // 3. Send generation request
      const completedCase = await casesApi
        .generateCase({
          ...request,
          traceId: caseId,
        })
        .then((res) =>
          // 4. Merge response with placeholder and save to DB
          ({
            ...placeholderCase,
            ...res,
            createdAt: new Date(),
          })
        )
        .catch((error) => ({
          ...placeholderCase,
          createdAt: new Date(),
          error: error instanceof Error ? error.message : "Unknown error",
        }));

      await db.cases.put(completedCase, completedCase.id);
      const savedCase = { ...completedCase };

      // Replace the placeholder matched by traceId with the saved case
      setCases((prev) =>
        prev.map((c) => (c.id === savedCase.id ? savedCase : c))
      );

      return savedCase.id;
    },
    []
  );

  const getCase = useCallback(
    (id: string) => {
      return cases.find((c) => c.id === id);
    },
    [cases]
  );

  const deleteCase = useCallback(async (id: string) => {
    try {
      await db.cases.delete(id);
      setCases((prev) => prev.filter((c) => c.id !== id));
    } catch (error) {
      console.error("Error deleting case:", error);
      throw error;
    }
  }, []);

  return (
    <CasesContext.Provider
      value={{ cases, isLoading, generateCase, getCase, deleteCase }}
    >
      {children}
    </CasesContext.Provider>
  );
}
