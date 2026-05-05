import { useState } from "react";
import { Analytics } from "@vercel/analytics/react";
import { Toolbar } from "./components/toolbar/Toolbar";
import { InstructionPalette } from "./components/panels/InstructionPalette";
import { PixiCanvas } from "./canvas/PixiCanvas";
import { TagPanel } from "./components/panels/TagPanel";
import { StatusBar } from "./components/panels/StatusBar";
import "./App.css";

export default function App() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  return (
    <div className="app-root" data-theme={theme}>
      <Toolbar theme={theme} onToggleTheme={() => setTheme(t => t === "dark" ? "light" : "dark")} />
      <div className="app-body">
        <InstructionPalette />
        <PixiCanvas />
        <TagPanel />
      </div>
      <StatusBar />
      <Analytics />
    </div>
  );
}
