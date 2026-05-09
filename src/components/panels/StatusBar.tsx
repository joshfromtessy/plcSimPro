import { useProjectStore } from "../../store/projectStore";
import { useSimulationStore } from "../../store/simulationStore";
import "./StatusBar.css";

export function StatusBar() {
  const { lastError, clearError } = useProjectStore();
  const {
    scanCount,
    lastScanDurationMs,
    lastScanDeltaMs,
    scanIntervalMs,
    taskOverrunCount,
    mode,
  } = useSimulationStore();

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        {lastError ? (
          <span className="statusbar-error" onClick={clearError} title="Click to dismiss">
            WARN {lastError}
          </span>
        ) : (
          <span className="statusbar-ok">Ready</span>
        )}
      </div>
      <div className="statusbar-right">
        {scanCount > 0 && (
          <span className="statusbar-scan">
            Scan #{scanCount} | task {scanIntervalMs}ms | delta {lastScanDeltaMs}ms | exec {lastScanDurationMs}ms
            {taskOverrunCount > 0 ? ` | overruns ${taskOverrunCount}` : ""}
          </span>
        )}
        <span className={`statusbar-mode statusbar-mode--${mode}`}>
          {mode.toUpperCase()}
        </span>
      </div>
    </div>
  );
}
