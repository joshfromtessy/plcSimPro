import { useEffect, useRef, useState } from "react";

interface FileMenuProps {
  onNew: () => void;
  onSave: () => void;
  onOpen: () => void;
}

export function FileMenu({ onNew, onSave, onOpen }: FileMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  function run(action: () => void) {
    action();
    setOpen(false);
  }

  return (
    <div className="toolbar-menu" ref={menuRef}>
      <button className="toolbar-btn" onClick={() => setOpen((value) => !value)}>
        File
      </button>
      {open && (
        <div className="toolbar-popover file-popover">
          <button className="toolbar-menu-row" onClick={() => run(onNew)}>
            New project
          </button>
          <button className="toolbar-menu-row" onClick={() => run(onSave)}>
            Save .plcsim
          </button>
          <button className="toolbar-menu-row" onClick={() => run(onOpen)}>
            Open .plcsim
          </button>
        </div>
      )}
    </div>
  );
}
