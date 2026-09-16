export interface Layer {
  id: string;
  name: string;
  /** Layer pixels; always the same size as the document. */
  canvas: HTMLCanvasElement;
  visible: boolean;
}

export interface Doc {
  width: number;
  height: number;
  /** Bottom → top. */
  layers: Layer[];
}

export type ToolId = 'select' | 'hand' | 'rect' | 'lasso' | 'brush' | 'eraser';
export type PanelId = 'menu' | 'expandCrop' | 'colorGrading' | 'replaceBg' | 'relight';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Point {
  x: number;
  y: number;
}

/** screen = doc * scale + (tx, ty) */
export interface Viewport {
  scale: number;
  tx: number;
  ty: number;
}

export interface ServerInfo {
  seedream: string;
  backgroundRemoval: 'wavespeed' | 'fal' | 'client';
}
