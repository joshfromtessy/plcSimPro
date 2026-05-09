import { useState } from "react";
import { Route, Routes } from "react-router-dom";
import { EditorPage } from "./pages/EditorPage";
import { AboutPage } from "./pages/AboutPage";
import { HelpPage } from "./pages/HelpPage";
import "./App.css";

export default function App() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  return (
    <Routes>
      <Route
        path="/"
        element={
          <EditorPage
            theme={theme}
            onToggleTheme={() => setTheme(t => t === "dark" ? "light" : "dark")}
          />
        }
      />
      <Route path="/help" element={<HelpPage theme={theme} />} />
      <Route path="/about" element={<AboutPage theme={theme} />} />
      <Route path="*" element={<HelpPage theme={theme} />} />
    </Routes>
  );
}
