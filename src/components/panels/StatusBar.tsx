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
            <span className="statusbar-metric">
              <span className="statusbar-label">Scan</span>
              <span className="statusbar-value statusbar-value--scan">#{scanCount}</span>
            </span>
            <span className="statusbar-sep">|</span>
            <span className="statusbar-metric">
              <span className="statusbar-label">task</span>
              <span className="statusbar-value">{scanIntervalMs}ms</span>
            </span>
            <span className="statusbar-sep">|</span>
            <span className="statusbar-metric">
              <span className="statusbar-label">delta</span>
              <span className="statusbar-value">{lastScanDeltaMs.toFixed(1)}ms</span>
            </span>
            <span className="statusbar-sep">|</span>
            <span className="statusbar-metric">
              <span className="statusbar-label">exec</span>
              <span className="statusbar-value">{lastScanDurationMs.toFixed(1)}ms</span>
            </span>
            {taskOverrunCount > 0 && (
              <>
                <span className="statusbar-sep">|</span>
                <span className="statusbar-metric">
                  <span className="statusbar-label">overruns</span>
                  <span className="statusbar-value statusbar-value--overruns">{taskOverrunCount}</span>
                </span>
              </>
            )}
          </span>
        )}
        <span className={`statusbar-mode statusbar-mode--${mode}`}>
          {mode.toUpperCase()}
        </span>
      </div>
    </div>
  );
}
