import { create } from 'zustand';
import type { Doc, Layer, PanelId, Rect, ServerInfo, ToolId, Viewport } from './types';
import { canvasFromImage, createCanvas, ctx2d, flattenDoc, loadImageFromFile, thumbnailUrl, uid } from './imageUtils';
import { clearMask, createMask } from './tools/mask';

const MAX_HISTORY = 30;

export interface EditorState {
  doc: Doc | null;
  history: Doc[];
  future: Doc[];
  /** Incremented whenever the document should be re-fitted to the screen (new image, crop...). */
  fitKey: number;
  backdropUrl: string | null;

  tool: ToolId;
  brushSize: number;
  mask: HTMLCanvasElement | null;
  maskVersion: number;

  panel: PanelId;
  viewport: Viewport;
  cropRect: Rect | null;
  /** When set, the canvas shows this instead of the flattened document (colour-grading live preview). */
  previewCanvas: HTMLCanvasElement | null;

  busy: string | null;
  error: string | null;
  serverInfo: ServerInfo | null;

  loadFile(file: File): Promise<void>;
  loadFromImage(img: HTMLImageElement): void;
  setDoc(doc: Doc, options?: { fit?: boolean; keepHistory?: boolean }): void;
  commit(doc: Doc, options?: { fit?: boolean }): void;
  undo(): void;
  redo(): void;

  setTool(tool: ToolId): void;
  setBrushSize(size: number): void;
  bumpMask(): void;
  resetMask(): void;

  setPanel(panel: PanelId): void;
  setViewport(vp: Viewport): void;
  requestFit(): void;
  setCropRect(rect: Rect | null): void;
  setPreviewCanvas(c: HTMLCanvasElement | null): void;

  setBusy(msg: string | null): void;
  setError(msg: string | null): void;
  setServerInfo(info: ServerInfo | null): void;

  addLayer(canvas: HTMLCanvasElement, name: string, options?: { index?: number; hideOthers?: boolean }): void;
  toggleLayer(id: string): void;
  removeLayer(id: string): void;
  renameLayer(id: string, name: string): void;
}

export const useEditor = create<EditorState>((set, get) => ({
  doc: null,
  history: [],
  future: [],
  fitKey: 0,
  backdropUrl: null,

  tool: 'select',
  brushSize: 40,
  mask: null,
  maskVersion: 0,

  panel: 'menu',
  viewport: { scale: 1, tx: 0, ty: 0 },
  cropRect: null,
  previewCanvas: null,

  busy: null,
  error: null,
  serverInfo: null,

  async loadFile(file) {
    get().loadFromImage(await loadImageFromFile(file));
  },

  loadFromImage(img) {
    const canvas = canvasFromImage(img);
    const base: Layer = { id: uid('layer'), name: 'Base', canvas, visible: true };
    const doc: Doc = { width: canvas.width, height: canvas.height, layers: [base] };
    set({ history: [], future: [], panel: 'menu', cropRect: null, previewCanvas: null });
    get().setDoc(doc, { fit: true });
  },

  setDoc(doc, options) {
    const prev = get();
    const sizeChanged = !prev.doc || prev.doc.width !== doc.width || prev.doc.height !== doc.height;
    const mask = sizeChanged || !prev.mask ? createMask(doc.width, doc.height) : prev.mask;
    if (!sizeChanged && prev.mask) clearMask(prev.mask);
    set({
      doc,
      mask,
      maskVersion: prev.maskVersion + 1,
      backdropUrl: thumbnailUrl(flattenDoc(doc), 64),
      fitKey: options?.fit || sizeChanged ? prev.fitKey + 1 : prev.fitKey,
    });
  },

  commit(doc, options) {
    const { doc: current, history } = get();
    if (current) {
      set({ history: [...history.slice(-(MAX_HISTORY - 1)), current], future: [] });
    }
    get().setDoc(doc, options);
  },

  undo() {
    const { doc, history, future } = get();
    if (!doc || history.length === 0) return;
    const prev = history[history.length - 1];
    set({ history: history.slice(0, -1), future: [doc, ...future] });
    get().setDoc(prev);
  },

  redo() {
    const { doc, history, future } = get();
    if (!doc || future.length === 0) return;
    const next = future[0];
    set({ history: [...history, doc], future: future.slice(1) });
    get().setDoc(next);
  },

  setTool: (tool) => set({ tool }),
  setBrushSize: (brushSize) => set({ brushSize: Math.max(2, Math.min(400, brushSize)) }),
  bumpMask: () => set((s) => ({ maskVersion: s.maskVersion + 1 })),
  resetMask() {
    const { mask } = get();
    if (mask) clearMask(mask);
    set((s) => ({ maskVersion: s.maskVersion + 1 }));
  },

  setPanel(panel) {
    set({ panel, previewCanvas: null, cropRect: null });
  },
  setViewport: (viewport) => set({ viewport }),
  requestFit: () => set((s) => ({ fitKey: s.fitKey + 1 })),
  setCropRect: (cropRect) => set({ cropRect }),
  setPreviewCanvas: (previewCanvas) => set({ previewCanvas }),

  setBusy: (busy) => set({ busy }),
  setError: (error) => set({ error }),
  setServerInfo: (serverInfo) => set({ serverInfo }),

  addLayer(canvas, name, options) {
    const { doc } = get();
    if (!doc) return;
    const layer: Layer = { id: uid('layer'), name, canvas, visible: true };
    let layers = options?.hideOthers ? doc.layers.map((l) => ({ ...l, visible: false })) : [...doc.layers];
    const index = options?.index ?? layers.length;
    layers = [...layers.slice(0, index), layer, ...layers.slice(index)];
    get().commit({ ...doc, layers });
  },

  toggleLayer(id) {
    const { doc } = get();
    if (!doc) return;
    get().commit({ ...doc, layers: doc.layers.map((l) => (l.id === id ? { ...l, visible: !l.visible } : l)) });
  },

  removeLayer(id) {
    const { doc } = get();
    if (!doc || doc.layers.length <= 1) return;
    get().commit({ ...doc, layers: doc.layers.filter((l) => l.id !== id) });
  },

  renameLayer(id, name) {
    const { doc } = get();
    if (!doc) return;
    set({ doc: { ...doc, layers: doc.layers.map((l) => (l.id === id ? { ...l, name } : l)) } });
  },
}));

/** Adds an uploaded image as a new layer, scaled to fit and centred on the document. */
export async function addImageFileAsLayer(file: File) {
  const { doc, addLayer } = useEditor.getState();
  if (!doc) return;
  const img = await loadImageFromFile(file);
  const k = Math.min(1, doc.width / img.naturalWidth, doc.height / img.naturalHeight);
  const w = img.naturalWidth * k;
  const h = img.naturalHeight * k;
  const c = createCanvas(doc.width, doc.height);
  ctx2d(c).drawImage(img, (doc.width - w) / 2, (doc.height - h) / 2, w, h);
  addLayer(c, file.name.replace(/\.[^.]+$/, ''));
}
