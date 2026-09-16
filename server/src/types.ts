export interface EditRequest {
  /** Full image as data URL (png/jpeg). */
  image: string;
  /** Same image with the selected region outlined (data URL). Optional for whole-image edits. */
  marked?: string;
  /** Bounding box of the selection normalised to a 0..1000 grid: [x1, y1, x2, y2]. */
  bbox?: [number, number, number, number];
  prompt: string;
  width: number;
  height: number;
}

export interface ExpandRequest {
  /** The original photo (data URL). */
  image: string;
  /** Target frame size; only its aspect ratio matters to the model. */
  width: number;
  height: number;
}

export interface ReplaceBackgroundRequest {
  image: string;
  prompt: string;
  width: number;
  height: number;
}

export interface ImageResult {
  /** Result image as data URL. */
  image: string;
  provider: string;
}

export interface SeedreamInput {
  prompt: string;
  /** Data URLs, in order (image 1, image 2, ...). */
  images: string[];
  width: number;
  height: number;
}

export interface SeedreamProvider {
  name: string;
  edit(input: SeedreamInput): Promise<string>;
}
