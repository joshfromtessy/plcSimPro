import { Toolbar } from "../components/toolbar/Toolbar";
import { InstructionPalette } from "../components/panels/InstructionPalette";
import { PixiCanvas } from "../canvas/PixiCanvas";
import { WorkspacePanel } from "../components/panels/WorkspacePanel";
import { StatusBar } from "../components/panels/StatusBar";
import { StructuredTextEditor } from "../components/panels/StructuredTextEditor";
import { useProjectStore } from "../store/projectStore";

interface EditorPageProps {
  theme: "dark" | "light";
  onToggleTheme: () => void;
}

export function EditorPage({ theme, onToggleTheme }: EditorPageProps) {
  const { project, activeRoutineId } = useProjectStore();
  const activeRoutine = activeRoutineId
    ? project.programs.flatMap(program => program.routines).find(routine => routine.id === activeRoutineId)
    : null;

  return (
    <div className="app-root" data-theme={theme}>
      <Toolbar theme={theme} onToggleTheme={onToggleTheme} />
      <div className="app-body">
        <WorkspacePanel />
        {activeRoutine?.language === "ST" ? (
          <StructuredTextEditor routine={activeRoutine} />
        ) : (
          <PixiCanvas theme={theme} />
        )}
        <InstructionPalette />
      </div>
      <StatusBar />
    </div>
  );
}
