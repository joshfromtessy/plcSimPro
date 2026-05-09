import { Toolbar } from "../components/toolbar/Toolbar";
import { InstructionPalette } from "../components/panels/InstructionPalette";
import { PixiCanvas } from "../canvas/PixiCanvas";
import { WorkspacePanel } from "../components/panels/WorkspacePanel";
import { StatusBar } from "../components/panels/StatusBar";

interface EditorPageProps {
  theme: "dark" | "light";
  onToggleTheme: () => void;
}

export function EditorPage({ theme, onToggleTheme }: EditorPageProps) {
  return (
    <div className="app-root" data-theme={theme}>
      <Toolbar theme={theme} onToggleTheme={onToggleTheme} />
      <div className="app-body">
        <WorkspacePanel />
        <PixiCanvas theme={theme} />
        <InstructionPalette />
      </div>
      <StatusBar />
    </div>
  );
}
