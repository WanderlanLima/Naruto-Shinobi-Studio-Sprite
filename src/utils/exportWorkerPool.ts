import { applyPalette, quantize } from 'gifenc';
import ExportEncoderWorker from '../workers/exportEncoderWorker?worker';
import type {
  WorkerEncoderRequest,
  WorkerEncoderResponse,
} from '../workers/exportEncoderWorker';

export interface QuantizedGifFrameResult {
  palette: Array<[number, number, number]>;
  indexed: Uint8Array;
  depth: number;
  transparent: boolean;
}

interface PendingJob {
  id: number;
  request: WorkerEncoderRequest;
  transfer: Transferable[];
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  currentJob: PendingJob | null;
}

const DEFAULT_POOL_SIZE =
  typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
    ? Math.max(2, Math.min(6, navigator.hardwareConcurrency - 1))
    : 3;

class ExportEncoderWorkerPool {
  private slots: WorkerSlot[] = [];
  private queue: PendingJob[] = [];
  private nextJobId = 1;
  private initialized = false;
  private workersAvailable = true;
  private pngWorkerSupported: boolean | null = null;

  get concurrency(): number {
    return this.workersAvailable ? DEFAULT_POOL_SIZE : 1;
  }

  private ensureInit() {
    if (this.initialized) return;
    this.initialized = true;

    if (typeof Worker === 'undefined') {
      this.workersAvailable = false;
      return;
    }

    try {
      for (let i = 0; i < DEFAULT_POOL_SIZE; i++) {
        const worker = new ExportEncoderWorker();
        const slot: WorkerSlot = { worker, busy: false, currentJob: null };

        worker.onmessage = (ev: MessageEvent<WorkerEncoderResponse>) => {
          const job = slot.currentJob;
          slot.currentJob = null;
          slot.busy = false;

          if (job) {
            const msg = ev.data;
            if (!msg.ok) {
              job.reject(new Error(msg.error || 'Worker encoding failed'));
            } else if (msg.type === 'quantize-gif-frame') {
              job.resolve({
                palette: msg.palette,
                indexed: new Uint8Array(msg.indexedBuffer),
                depth: msg.depth,
                transparent: msg.transparent,
              } satisfies QuantizedGifFrameResult);
            } else if (msg.type === 'encode-png-bitmap') {
              job.resolve(msg.blob);
            }
          }
          this.pump();
        };

        worker.onerror = (err) => {
          const job = slot.currentJob;
          slot.currentJob = null;
          slot.busy = false;
          if (job) {
            job.reject(err instanceof ErrorEvent ? new Error(err.message) : err);
          }
          this.pump();
        };

        this.slots.push(slot);
      }
    } catch {
      this.workersAvailable = false;
      this.slots = [];
    }
  }

  private pump() {
    if (this.queue.length === 0) return;
    for (const slot of this.slots) {
      if (this.queue.length === 0) break;
      if (!slot.busy) {
        const job = this.queue.shift()!;
        slot.busy = true;
        slot.currentJob = job;
        try {
          slot.worker.postMessage(job.request, job.transfer);
        } catch (err) {
          slot.busy = false;
          slot.currentJob = null;
          job.reject(err);
        }
      }
    }
  }

  private enqueue<T>(
    buildRequest: (id: number) => { request: WorkerEncoderRequest; transfer: Transferable[] }
  ): Promise<T> {
    this.ensureInit();
    if (!this.workersAvailable || this.slots.length === 0) {
      return Promise.reject(new Error('Web Workers indisponíveis'));
    }
    const id = this.nextJobId++;
    const { request, transfer } = buildRequest(id);
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        id,
        request,
        transfer,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.pump();
    });
  }

  async quantizeGifFrame(
    rgbaBuffer: ArrayBuffer,
    width: number,
    height: number,
    opaqueBg: boolean
  ): Promise<QuantizedGifFrameResult> {
    this.ensureInit();
    if (this.workersAvailable && this.slots.length > 0) {
      try {
        return await this.enqueue<QuantizedGifFrameResult>((id) => ({
          request: {
            id,
            type: 'quantize-gif-frame',
            rgbaBuffer,
            width,
            height,
            opaqueBg,
          },
          transfer: [rgbaBuffer],
        }));
      } catch {
        // Fall through to synchronous fallback if worker transfer fails
      }
    }
    return quantizeGifFrameSync(rgbaBuffer, width, height, opaqueBg);
  }

  async encodeCanvasToPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
    this.ensureInit();
    const canTryWorkerPng =
      this.workersAvailable &&
      this.slots.length > 0 &&
      this.pngWorkerSupported !== false &&
      typeof createImageBitmap === 'function' &&
      typeof OffscreenCanvas !== 'undefined';

    if (canTryWorkerPng) {
      try {
        const bitmap = await createImageBitmap(canvas);
        const blob = await this.enqueue<Blob>((id) => ({
          request: {
            id,
            type: 'encode-png-bitmap',
            bitmap,
          },
          transfer: [bitmap],
        }));
        this.pngWorkerSupported = true;
        return blob;
      } catch {
        this.pngWorkerSupported = false;
      }
    }

    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    });
  }
}

export function quantizeGifFrameSync(
  rgbaBuffer: ArrayBuffer,
  width: number,
  height: number,
  opaqueBg: boolean
): QuantizedGifFrameResult {
  const rgba = new Uint8Array(rgbaBuffer);

  if (opaqueBg) {
    const rawPalette = quantize(rgba, 256, { format: 'rgb565' });
    const palette: Array<[number, number, number]> = rawPalette.map(
      (c) => [c[0], c[1], c[2]] as [number, number, number]
    );
    while (palette.length < 4) palette.push([0, 0, 0]);
    const indexed = applyPalette(rgba, palette, 'rgb565');
    const depth = Math.max(2, Math.ceil(Math.log2(palette.length)));
    return {
      palette,
      indexed,
      depth,
      transparent: false,
    };
  }

  const totalPixels = width * height;
  const opaqueMask = new Uint8Array(totalPixels);
  let opaqueCount = 0;
  for (let px = 0, p = 0; px < totalPixels; px++, p += 4) {
    if (rgba[p + 3] >= 32) {
      opaqueMask[px] = 1;
      opaqueCount++;
    }
  }

  const opaqueRgba = new Uint8Array(Math.max(4, opaqueCount * 4));
  if (opaqueCount === 0) {
    opaqueRgba[0] = 0;
    opaqueRgba[1] = 0;
    opaqueRgba[2] = 0;
    opaqueRgba[3] = 255;
  } else {
    let wIdx = 0;
    for (let px = 0, p = 0; px < totalPixels; px++, p += 4) {
      if (opaqueMask[px]) {
        opaqueRgba[wIdx++] = rgba[p];
        opaqueRgba[wIdx++] = rgba[p + 1];
        opaqueRgba[wIdx++] = rgba[p + 2];
        opaqueRgba[wIdx++] = 255;
      }
    }
  }

  const opaquePalette = quantize(opaqueRgba, 255, { format: 'rgb565' });
  const finalPalette: Array<[number, number, number]> = [
    [0, 0, 0],
    ...opaquePalette.map((c) => [c[0], c[1], c[2]] as [number, number, number]),
  ];
  while (finalPalette.length < 4) finalPalette.push([0, 0, 0]);

  const finalIndexed = new Uint8Array(totalPixels);
  if (opaqueCount > 0) {
    const opaqueIndexed = applyPalette(rgba, opaquePalette, 'rgb565');
    for (let px = 0; px < totalPixels; px++) {
      finalIndexed[px] = opaqueMask[px] ? opaqueIndexed[px] + 1 : 0;
    }
  }

  const depth = Math.max(2, Math.ceil(Math.log2(finalPalette.length)));
  return {
    palette: finalPalette,
    indexed: finalIndexed,
    depth,
    transparent: true,
  };
}

export const exportWorkerPool = new ExportEncoderWorkerPool();
