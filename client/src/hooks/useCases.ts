import { useContext } from "react";
import { CasesContext, type CasesContextType } from "@/context/CasesContext";

export function useCases(): CasesContextType {
  const context = useContext(CasesContext);
  if (!context) {
    throw new Error("useCases must be used within a CasesProvider");
  }
  return context;
}
