import { useEffect, useRef, useState } from 'react';
import { useEditor } from './editor/store';
import { EditorCanvas } from './editor/canvas/EditorCanvas';
import { SidePanel } from './editor/panels/SidePanel';
import { LayersPanel } from './editor/panels/LayersPanel';
import { Toolbar } from './editor/Toolbar';
import { GlobalPromptBar } from './editor/PromptBox';
import { apiFetchImage, apiHealth } from './editor/api';
import { downloadCanvas, flattenDoc, loadImage } from './editor/imageUtils';
import { zoomAt } from './editor/canvas/viewport';
import { IconClose, IconDownload, IconMinus, IconPlus, IconRedo, IconUndo, IconUpload } from './editor/Icons';

function ZoomControls() {
  const viewport = useEditor((s) => s.viewport);
  const setViewport = useEditor((s) => s.setViewport);
  const requestFit = useEditor((s) => s.requestFit);
  const doc = useEditor((s) => s.doc);
  const zoom = (f: number) => {
    const host = document.querySelector('.canvas-host');
    const r = host?.getBoundingClientRect();
    setViewport(zoomAt(viewport, f, { x: r ? r.width / 2 : 0, y: r ? r.height / 2 : 0 }));
  };
  return (
    <div className="zoom">
      <button className="ghost small" disabled={!doc} onClick={() => zoom(1 / 1.25)} title="Zoom out">
        <IconMinus width={16} height={16} />
      </button>
      <button className="ghost small pct" disabled={!doc} onClick={requestFit} title="Fit to screen (0)">
        {Math.round(viewport.scale * 100)}%
      </button>
      <button className="ghost small" disabled={!doc} onClick={() => zoom(1.25)} title="Zoom in">
        <IconPlus width={16} height={16} />
      </button>
    </div>
  );
}

function DropZone() {
  const loadFile = useEditor((s) => s.loadFile);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="dropzone" onClick={() => ref.current?.click()}>
      <input ref={ref} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && void loadFile(e.target.files[0])} />
      <div className="dz-box">
        <div className="dz-icon">
          <IconUpload width={28} height={28} />
        </div>
        <div className="dz-title">Open an image to start</div>
        <div className="muted">Drop a file anywhere, paste from clipboard, or click to browse</div>
      </div>
    </div>
  );
}

export default function App() {
  const doc = useEditor((s) => s.doc);
  const busy = useEditor((s) => s.busy);
  const error = useEditor((s) => s.error);
  const setError = useEditor((s) => s.setError);
  const loadFile = useEditor((s) => s.loadFile);
  const loadFromImage = useEditor((s) => s.loadFromImage);
  const setServerInfo = useEditor((s) => s.setServerInfo);
  const canUndo = useEditor((s) => s.history.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    void apiHealth().then(setServerInfo);
  }, [setServerInfo]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      const s = useEditor.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) s.redo();
        else s.undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        s.redo();
        return;
      }
      if (mod) return;
      switch (e.key.toLowerCase()) {
        case 'v':
          s.setTool('select');
          break;
        case 'h':
          s.setTool('hand');
          break;
        case 'm':
          s.setTool('rect');
          break;
        case 'l':
          s.setTool('lasso');
          break;
        case 'b':
          s.setTool('brush');
          break;
        case 'e':
          s.setTool('eraser');
          break;
        case '[':
          s.setBrushSize(Math.round(s.brushSize / 1.2));
          break;
        case ']':
          s.setBrushSize(Math.round(s.brushSize * 1.2));
          break;
        case 'escape':
          if (s.panel !== 'menu') s.setPanel('menu');
          else s.resetMask();
          break;
        case '0':
          s.requestFit();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Drag & drop (files from disk, images from other tabs, image URLs) and paste anywhere
  useEffect(() => {
    const loadUrl = async (url: string) => {
      try {
        const dataUrl = url.startsWith('data:') ? url : await apiFetchImage(url);
        loadFromImage(await loadImage(dataUrl));
      } catch (e) {
        setError((e as Error).message);
      }
    };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      const dt = e.dataTransfer;
      if (!dt) return;
      const f = Array.from(dt.files).find((x) => x.type.startsWith('image/'));
      if (f) {
        void loadFile(f);
        return;
      }
      const html = dt.getData('text/html');
      const src = /<img[^>]+src=["']([^"']+)["']/i.exec(html)?.[1];
      const uri = src || dt.getData('text/uri-list') || dt.getData('text/plain');
      if (uri && /^(https?:|data:image)/.test(uri.trim())) void loadUrl(uri.trim());
    };
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    };
    const onDragLeave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'));
      const f = item?.getAsFile();
      if (f) void loadFile(f);
    };
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('paste', onPaste);
    };
  }, [loadFile, loadFromImage, setError]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          <span>
            Image Studio
            {doc && (
              <span className="brand-sub">
                {' '}
                · {doc.width} × {doc.height}
              </span>
            )}
          </span>
        </div>
        <div className="topbar-center">
          <GlobalPromptBar />
        </div>
        <div className="topbar-right">
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && void loadFile(e.target.files[0])} />
          <button className="btn icon" title="Open image" onClick={() => fileRef.current?.click()}>
            <IconUpload width={18} height={18} />
          </button>
          <span className="divider" />
          <button className="ghost small" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
            <IconUndo width={18} height={18} />
          </button>
          <button className="ghost small" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>
            <IconRedo width={18} height={18} />
          </button>
          <span className="divider" />
          <ZoomControls />
          <span className="divider" />
          <button className="btn primary" disabled={!doc} onClick={() => doc && downloadCanvas(flattenDoc(doc), 'edited.png')}>
            <IconDownload width={16} height={16} /> Export
          </button>
        </div>
      </header>

      <div className="workspace">
        <Toolbar />
        <SidePanel />
        <main className="main">
          <EditorCanvas />
          {!doc && <DropZone />}
          {dragging && (
            <div className="drag-overlay">
              <IconUpload width={40} height={40} />
              <div>Drop image to open</div>
            </div>
          )}
          {busy && <div className="busy-shield" />}
          {busy && (
            <div className="busy">
              <div className="spinner" />
              <div>{busy}</div>
            </div>
          )}
          {error && (
            <div className="toast">
              <span>{error}</span>
              <button className="ghost small" onClick={() => setError(null)}>
                <IconClose width={16} height={16} />
              </button>
            </div>
          )}
        </main>
        <aside className="layers-col">
          <LayersPanel />
        </aside>
      </div>
    </div>
  );
}
