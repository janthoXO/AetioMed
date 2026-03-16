import { Routes, Route } from "react-router-dom";
import { CasesProvider } from "@/context/CasesContext";
import Layout from "@/pages/Layout";
import HomePage from "@/pages/HomePage";
import CaseDetailPage from "@/pages/CaseDetailPage";
import { GeneratingCaseView } from "@/pages/GeneratingCaseView";
import { ThemeProvider } from "./context/ThemeProvider";

function App() {
  return (
    <ThemeProvider storageKey="vite-ui-theme">
      <CasesProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<HomePage />} />
            <Route path="cases/:caseId" element={<CaseDetailPage />} />
            <Route path="cases/:caseId/generating" element={<GeneratingCaseView />} />
          </Route>
        </Routes>
      </CasesProvider>
    </ThemeProvider>
  );
}

export default App;
