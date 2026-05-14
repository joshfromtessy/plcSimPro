import { useEffect, useRef } from "react";
import { Application } from "pixi.js";
import { LadderRenderer } from "../../canvas/renderer";
import type { Routine, TagDefinition } from "../../model/types";

interface CommunityRoutinePreviewProps {
  routine: Routine;
  tags: TagDefinition[];
  theme: "dark" | "light";
}

export function CommunityRoutinePreview({ routine, tags, theme }: CommunityRoutinePreviewProps) {
  if (routine.language === "ST") {
    return <StructuredTextPreview source={routine.structuredText ?? ""} />;
  }

  return <LadderPreview routine={routine} tags={tags} theme={theme} />;
}

function LadderPreview({ routine, tags, theme }: CommunityRoutinePreviewProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<Application | null>(null);
  const rendererRef = useRef<LadderRenderer | null>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const container = canvasRef.current;
    if (!container) return;

    let disposed = false;
    const app = new Application();
    void app.init({
      background: getCanvasBackground(theme).hex,
      backgroundAlpha: 0,
      antialias: true,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      width: container.clientWidth || 760,
      height: container.clientHeight || 420,
    }).then(() => {
      if (disposed || !canvasRef.current) {
        app.destroy(true);
        return;
      }

      canvasRef.current.appendChild(app.canvas);
      app.canvas.style.display = "block";
      app.canvas.style.position = "absolute";
      app.canvas.style.top = "0";
      app.canvas.style.left = "0";
      app.canvas.style.width = "100%";

      const renderer = new LadderRenderer(app);
      renderer.setCommentVisibility(false, true);
      appRef.current = app;
      rendererRef.current = renderer;
      renderLadderPreview(canvasRef.current, app, renderer, routine, tags, theme);
    });

    const ro = new ResizeObserver(() => {
      const currentApp = appRef.current;
      const renderer = rendererRef.current;
      const currentContainer = canvasRef.current;
      if (!currentApp || !renderer || !currentContainer || currentContainer.clientWidth === 0) return;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => {
        renderLadderPreview(currentContainer, currentApp, renderer, routine, tags, theme);
      });
    });
    ro.observe(container);

    return () => {
      disposed = true;
      ro.disconnect();
      cancelAnimationFrame(rafRef.current);
      rendererRef.current?.destroy();
      appRef.current?.destroy(true);
      rendererRef.current = null;
      appRef.current = null;
    };
  }, []);

  useEffect(() => {
    const app = appRef.current;
    const renderer = rendererRef.current;
    const container = canvasRef.current;
    if (!app || !renderer || !container) return;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      renderLadderPreview(container, app, renderer, routine, tags, theme);
    });
  }, [routine, tags, theme]);

  return <div className="community-routine-canvas" ref={canvasRef} />;
}

function renderLadderPreview(
  container: HTMLDivElement,
  app: Application,
  renderer: LadderRenderer,
  routine: Routine,
  tags: TagDefinition[],
  theme: "dark" | "light"
) {
  const background = getCanvasBackground(theme);
  const pixiRenderer = app.renderer as any;
  if (pixiRenderer.background) {
    pixiRenderer.background.color = background.hex;
    pixiRenderer.background.alpha = 0;
  }
  app.canvas.style.backgroundColor = background.css;
  renderer.setThemeColors(getRendererColors(theme));
  renderer.setTagData(tags);
  renderer.setSelection(null, null);

  const tagValues = new Map<string, boolean>(tags.map(tag => [tag.name, Boolean(tag.value)]));
  const viewportH = container.clientHeight || 420;
  const viewportW = container.clientWidth || 760;
  const { h: contentH, w: contentW } = renderer.render(
    routine.rungs,
    new Map(),
    viewportW,
    tagValues,
    viewportH,
    { readOnly: true }
  );
  const nextW = Math.max(viewportW, contentW);
  const nextH = Math.max(viewportH, contentH);
  app.renderer.resize(nextW, nextH);
  app.canvas.style.width = nextW > viewportW ? `${nextW}px` : "100%";
  app.canvas.style.height = `${nextH}px`;
  app.canvas.style.visibility = routine.rungs.length === 0 ? "hidden" : "visible";
}

function StructuredTextPreview({ source }: { source: string }) {
  const lines = source ? source.split(/\r?\n/) : [""];

  return (
    <div className="community-st-preview">
      <div className="community-st-line-numbers" aria-hidden="true">
        {lines.map((_, index) => <span key={index}>{index + 1}</span>)}
      </div>
      <pre>{source || "// Empty structured text routine"}</pre>
    </div>
  );
}

function getCanvasBackground(theme: "dark" | "light") {
  return theme === "light"
    ? { hex: 0xf3f4f8, css: "#f3f4f8" }
    : { hex: 0x18181e, css: "#18181e" };
}

function getRendererColors(theme: "dark" | "light") {
  const shared = {
    wireOn: 0x22cc66,
    railOn: 0x22cc66,
    nodeOn: 0x22cc66,
    nodeSelected: 0x4a8cff,
    textBlue: 0x4a8cff,
    textYellow: 0xf0b429,
    textGreen: 0x22cc66,
    branchRailOn: 0x22cc66,
  };

  if (theme === "light") {
    return {
      ...shared,
      wireOff: 0x535b7a,
      rail: 0x4f5590,
      nodeBg: 0xffffff,
      nodeBorder: 0x68708f,
      nodeOnBg: 0xdbf8e8,
      textPrimary: 0x171927,
      textDim: 0x69708e,
      textYellow: 0x9a5a00,
      gutterBg: 0xe8eaf2,
      canvasBg: 0xf3f4f8,
      separator: 0xc3c7d6,
      branchRail: 0x535b7a,
    };
  }

  return {
    ...shared,
    wireOff: 0x64657a,
    rail: 0x5858a0,
    nodeBg: 0x1e1e2a,
    nodeBorder: 0x3a3a56,
    nodeOnBg: 0x0a1f12,
    textPrimary: 0xe8e8f0,
    textDim: 0x6f7088,
    gutterBg: 0x1e1e26,
    canvasBg: 0x18181e,
    separator: 0x2e2e3a,
    branchRail: 0x4a4a5a,
  };
}
