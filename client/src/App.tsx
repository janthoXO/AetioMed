import { Routes, Route } from "react-router-dom";
import { CasesProvider } from "@/context/CasesContext";
import Layout from "@/pages/Layout";
import HomePage from "@/pages/HomePage";
import CaseDetailPage from "@/pages/CaseDetailPage";
import { ThemeProvider } from "./context/ThemeProvider";
import RunResultPage from "@/pages/RunResultPage";
import RunTracesPage from "./pages/RunTracesPage";

function App() {
  return (
    <ThemeProvider storageKey="vite-ui-theme">
      <CasesProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<HomePage />} />
            <Route path="cases/:caseId" element={<CaseDetailPage />} />
            <Route
              path="cases/:caseId/runs/:runId"
              element={<RunResultPage />}
            />
            <Route
              path="cases/:caseId/runs/:runId/traces"
              element={<RunTracesPage />}
            />
          </Route>
        </Routes>
      </CasesProvider>
    </ThemeProvider>
  );
}

export default App;
