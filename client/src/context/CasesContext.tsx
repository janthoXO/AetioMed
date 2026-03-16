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
  generateCase: (request: CaseGenerationRequest) => Promise<number>;
  getCase: (id: number) => Case | undefined;
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
          setCases(
            serverCases.sort(
              (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime()
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
    async (request: CaseGenerationRequest): Promise<number> => {
      const createdAt = new Date();
      try {
        // 1. Create a placeholder case with input params (no id = not yet persisted)
        const placeholderCase: Case = {
          diagnosis: {
            name: request.diagnosis,
            icd: request.icd,
          },
          createdAt,
          generationFlags: request.generationFlags,
          language: request.language ?? config.language,
        };

        // 2. Add placeholder to context array immediately (shows skeleton in sidebar)
        setCases((prev) => [placeholderCase, ...prev]);

        // 3. Send generation request
        const response = await casesApi.generateCase(request);

        // 4. Merge response with placeholder and save to DB
        const completedCase: Case = {
          ...placeholderCase,
          chiefComplaint: response.chiefComplaint,
          anamnesis: response.anamnesis,
          procedures: response.procedures,
        };

        const id = (await db.cases.add(completedCase)) as number;
        const savedCase = { ...completedCase, id };

        // Replace the placeholder (matched by createdAt) with the saved case
        setCases((prev) =>
          prev.map((c) => (c.createdAt === createdAt ? savedCase : c))
        );

        return id;
      } catch (error) {
        setCases((prev) => prev.filter((c) => c.createdAt !== createdAt));
        console.error("Error generating case:", error);
        throw error;
      }
    },
    []
  );

  const getCase = useCallback(
    (id: number) => {
      return cases.find((c) => c.id === id);
    },
    [cases]
  );

  return (
    <CasesContext.Provider value={{ cases, isLoading, generateCase, getCase }}>
      {children}
    </CasesContext.Provider>
  );
}
