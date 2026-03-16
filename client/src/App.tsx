import { Routes, Route } from "react-router-dom";
import { CasesProvider } from "@/context/CasesContext";
import Layout from "@/pages/Layout";
import HomePage from "@/pages/HomePage";
import CaseDetailPage from "@/pages/CaseDetailPage";
import { ThemeProvider } from "./context/ThemeProvider";

function App() {
  return (
    <ThemeProvider storageKey="vite-ui-theme">
      <CasesProvider>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<HomePage />} />
            <Route path="cases/:id" element={<CaseDetailPage />} />
          </Route>
        </Routes>
      </CasesProvider>
    </ThemeProvider>
  );
}

export default App;
