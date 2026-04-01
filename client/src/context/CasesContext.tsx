/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { BackendCase, Case, CaseRun, LLMConfig } from "@/models/Case";
import type { CaseGenerationRequest } from "@/api/dto/case-generation-request";
import { config } from "@/config";
import { db } from "@/db/db";
import * as casesApi from "@/api/cases.api";

export type CasesContextType = {
  cases: Case[];
  isLoading: boolean;
  generateCase: (
    request: CaseGenerationRequest,
    llmConfig?: LLMConfig
  ) => Promise<number>;
  addRunToCase: (
    caseId: number,
    request: CaseGenerationRequest,
    llmConfig?: LLMConfig
  ) => Promise<void>;
  retryRun: (caseId: number, runId: number) => Promise<void>;
  getCase: (id: number) => Case | undefined;
  getRun: (caseId: number, runId: number) => CaseRun | undefined;
  deleteCase: (id: number) => Promise<void>;
};

export const CasesContext = createContext<CasesContextType | null>(null);

export function CasesProvider({ children }: { children: ReactNode }) {
  const [cases, setCases] = useState<Case[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Load cases on mount
  useEffect(() => {
    const loadCases = async () => {
      const localCases = await db.cases
        .orderBy("createdAt")
        .reverse()
        .toArray();
      const localRuns = await db.runs.toArray();

      const mappedCases = localCases.map((c) => ({
        ...c,
        runs: localRuns.filter((r) => r.caseId === c.id),
      }));

      setCases(mappedCases);
    };

    setIsLoading(true);
    loadCases().finally(() => setIsLoading(false));
  }, []);

  const generateCase = useCallback(
    async (
      request: CaseGenerationRequest,
      llmConfig?: LLMConfig
    ): Promise<number> => {
      const insertionCase = {
        diagnosis: {
          name: request.diagnosis,
          icd: request.icd,
        },
        createdAt: new Date(),
        generationFlags: request.generationFlags,
        language: request.language ?? config.language,
      };

      // 1. create the Case in the db (without runs) to get autoincremented id
      const id = await db.cases.add(insertionCase);
      const createdCase: Case = { ...insertionCase, id, runs: [] };

      setCases((prev) => [createdCase, ...prev]);

      // 2. add the first run to it async
      addRunToCase(id, request, llmConfig);

      return id;
    },
    []
  );

  const addRunToCase = useCallback(
    async (
      caseId: number,
      request: CaseGenerationRequest,
      llmConfig?: LLMConfig
    ): Promise<void> => {
      const traceId = crypto.randomUUID(); // still use string for tracing
      const runId = await db.runs.add({
        caseId,
        llmConfig,
        status: "generating",
        traceId,
      });

      const placeholderRun: CaseRun = {
        runId,
        caseId,
        llmConfig,
        status: "generating",
        traceId,
      };

      setCases((prev) =>
        prev.map((c) =>
          c.id === caseId ? { ...c, runs: [...c.runs, placeholderRun] } : c
        )
      );

      let completedRun: CaseRun;
      try {
        const res = (await casesApi.generateCase({
          ...request,
          llmConfig,
          traceId,
        })) as BackendCase;

        completedRun = {
          runId,
          caseId,
          llmConfig,
          status: "complete",
          traceId,
          patient: res.patient,
          chiefComplaint: res.chiefComplaint,
          anamnesis: res.anamnesis,
          procedures: res.procedures,
        };
      } catch (error) {
        completedRun = {
          runId,
          caseId,
          llmConfig,
          status: "error",
          traceId,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }

      await db.runs.put({ ...completedRun, caseId });

      setCases((prev) =>
        prev.map((c) =>
          c.id === caseId
            ? {
                ...c,
                runs: c.runs.map((r) => (r.runId === runId ? completedRun : r)),
              }
            : c
        )
      );
    },
    []
  );

  const retryRun = useCallback(
    async (caseId: number, runId: number): Promise<void> => {
      const existingCase = cases.find((c) => c.id === caseId);
      if (!existingCase) return;
      const existingRun = existingCase.runs.find((r) => r.runId === runId);
      if (!existingRun) return;

      const request: CaseGenerationRequest = {
        diagnosis: existingCase.diagnosis.name,
        icd: existingCase.diagnosis.icd,
        generationFlags: existingCase.generationFlags,
        language: existingCase.language,
      };

      const traceId = crypto.randomUUID();
      const placeholderRun: CaseRun = {
        runId,
        caseId,
        llmConfig: existingRun.llmConfig,
        status: "generating",
        traceId,
      };

      await db.runs.put({ ...placeholderRun, caseId });

      setCases((prev) =>
        prev.map((c) =>
          c.id === caseId
            ? {
                ...c,
                runs: c.runs.map((r) =>
                  r.runId === runId ? placeholderRun : r
                ),
              }
            : c
        )
      );

      let completedRun: CaseRun;
      try {
        const res = (await casesApi.generateCase({
          ...request,
          llmConfig: existingRun.llmConfig,
          traceId,
        })) as BackendCase;

        completedRun = {
          runId,
          caseId,
          llmConfig: existingRun.llmConfig,
          status: "complete",
          traceId,
          patient: res.patient,
          chiefComplaint: res.chiefComplaint,
          anamnesis: res.anamnesis,
          procedures: res.procedures,
        };
      } catch (error) {
        completedRun = {
          runId,
          caseId,
          llmConfig: existingRun.llmConfig,
          status: "error",
          traceId,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }

      await db.runs.put({ ...completedRun, caseId });

      setCases((prev) =>
        prev.map((c) =>
          c.id === caseId
            ? {
                ...c,
                runs: c.runs.map((r) => (r.runId === runId ? completedRun : r)),
              }
            : c
        )
      );
    },
    [cases]
  );

  const getCase = useCallback(
    (id: number) => {
      return cases.find((c) => c.id === id);
    },
    [cases]
  );

  const getRun = useCallback(
    (caseId: number, runId: number) => {
      return cases
        .find((c) => c.id === caseId)
        ?.runs.find((r) => r.runId === runId);
    },
    [cases]
  );

  const deleteCase = useCallback(async (id: number) => {
    try {
      await db.transaction("rw", db.cases, db.runs, async () => {
        await db.cases.delete(id);
        const runsToDelete = await db.runs.where({ caseId: id }).primaryKeys();
        await db.runs.bulkDelete(runsToDelete);
      });
      setCases((prev) => prev.filter((c) => c.id !== id));
    } catch (error) {
      console.error("Error deleting case:", error);
      throw error;
    }
  }, []);

  return (
    <CasesContext.Provider
      value={{
        cases,
        isLoading,
        generateCase,
        addRunToCase,
        retryRun,
        getCase,
        getRun,
        deleteCase,
      }}
    >
      {children}
    </CasesContext.Provider>
  );
}
