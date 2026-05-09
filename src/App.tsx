import { useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { EditorPage } from "./pages/EditorPage";
import { AboutPage } from "./pages/AboutPage";
import { HelpPage } from "./pages/HelpPage";
import { AuthPage } from "./pages/AuthPage";
import { AccountPage } from "./pages/AccountPage";
import { useAuthStore } from "./store/authStore";
import "./App.css";

export default function App() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const initializeAuth = useAuthStore((s) => s.initialize);

  useEffect(() => {
    void initializeAuth();
  }, [initializeAuth]);

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
      <Route path="/login" element={<AuthPage theme={theme} mode="login" />} />
      <Route path="/signup" element={<AuthPage theme={theme} mode="signup" />} />
      <Route path="/account" element={<AccountPage theme={theme} />} />
      <Route path="*" element={<HelpPage theme={theme} />} />
    </Routes>
  );
}
