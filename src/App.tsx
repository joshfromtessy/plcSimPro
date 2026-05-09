import { useState } from "react";
import { Toolbar } from "./components/toolbar/Toolbar";
import { InstructionPalette } from "./components/panels/InstructionPalette";
import { PixiCanvas } from "./canvas/PixiCanvas";
import { WorkspacePanel } from "./components/panels/WorkspacePanel";
import { StatusBar } from "./components/panels/StatusBar";
import "./App.css";

export default function App() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  return (
    <div className="app-root" data-theme={theme}>
      <Toolbar theme={theme} onToggleTheme={() => setTheme(t => t === "dark" ? "light" : "dark")} />
      <div className="app-body">
        <WorkspacePanel />
        <PixiCanvas />
        <InstructionPalette />
      </div>
      <StatusBar />
    </div>
  );
}
