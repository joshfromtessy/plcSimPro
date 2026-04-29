import { useProjectStore } from "../../store/projectStore";
import { useSimulationStore } from "../../store/simulationStore";
import "./StatusBar.css";

export function StatusBar() {
  const { lastError, clearError } = useProjectStore();
  const { scanCount, lastScanDurationMs, mode } = useSimulationStore();

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        {lastError ? (
          <span className="statusbar-error" onClick={clearError} title="Click to dismiss">
            ⚠ {lastError}
          </span>
        ) : (
          <span className="statusbar-ok">Ready</span>
        )}
      </div>
      <div className="statusbar-right">
        {scanCount > 0 && (
          <span className="statusbar-scan">
            Scan #{scanCount} · {lastScanDurationMs}ms
          </span>
        )}
        <span className={`statusbar-mode statusbar-mode--${mode}`}>
          {mode.toUpperCase()}
        </span>
      </div>
    </div>
  );
}
