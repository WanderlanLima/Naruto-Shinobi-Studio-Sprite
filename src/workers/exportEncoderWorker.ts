import { applyPalette, quantize } from 'gifenc';

export interface QuantizeGifFrameRequest {
  id: number;
  type: 'quantize-gif-frame';
  rgbaBuffer: ArrayBuffer;
  width: number;
  height: number;
  opaqueBg: boolean;
}

export interface EncodePngBitmapRequest {
  id: number;
  type: 'encode-png-bitmap';
  bitmap: ImageBitmap;
}

export type WorkerEncoderRequest = QuantizeGifFrameRequest | EncodePngBitmapRequest;

export interface QuantizeGifFrameResponse {
  id: number;
  type: 'quantize-gif-frame';
  ok: true;
  palette: Array<[number, number, number]>;
  indexedBuffer: ArrayBuffer;
  depth: number;
  transparent: boolean;
}

export interface EncodePngBitmapResponse {
  id: number;
  type: 'encode-png-bitmap';
  ok: true;
  blob: Blob;
}

export interface WorkerEncoderErrorResponse {
  id: number;
  type: 'error';
  ok: false;
  error: string;
}

export type WorkerEncoderResponse =
  | QuantizeGifFrameResponse
  | EncodePngBitmapResponse
  | WorkerEncoderErrorResponse;

let reusableOffscreen: OffscreenCanvas | null = null;
let reusableOffscreenCtx: OffscreenCanvasRenderingContext2D | null = null;

function quantizeSingleGifFrame(
  rgbaBuffer: ArrayBuffer,
  width: number,
  height: number,
  opaqueBg: boolean
): Omit<QuantizeGifFrameResponse, 'id' | 'type' | 'ok'> {
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
      indexedBuffer: indexed.buffer as ArrayBuffer,
      depth,
      transparent: false,
    };
  }

  // Extract only opaque pixels so transparent index 0 never collides with black outlines
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
    [0, 0, 0], // Index 0 is strictly reserved as the transparent background index
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
    indexedBuffer: finalIndexed.buffer as ArrayBuffer,
    depth,
    transparent: true,
  };
}

async function encodeBitmapToPng(bitmap: ImageBitmap): Promise<Blob> {
  if (typeof OffscreenCanvas === 'undefined') {
    bitmap.close();
    throw new Error('OffscreenCanvas indisponível no Worker.');
  }
  const w = bitmap.width;
  const h = bitmap.height;
  if (!reusableOffscreen) {
    reusableOffscreen = new OffscreenCanvas(w, h);
    reusableOffscreenCtx = reusableOffscreen.getContext('2d');
  } else if (reusableOffscreen.width !== w || reusableOffscreen.height !== h) {
    reusableOffscreen.width = w;
    reusableOffscreen.height = h;
    reusableOffscreenCtx = reusableOffscreen.getContext('2d');
  }
  if (!reusableOffscreenCtx) {
    bitmap.close();
    throw new Error('Contexto 2D indisponível no OffscreenCanvas.');
  }
  reusableOffscreenCtx.clearRect(0, 0, w, h);
  reusableOffscreenCtx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return await reusableOffscreen.convertToBlob({ type: 'image/png' });
}

const workerScope = self as unknown as {
  onmessage: ((ev: MessageEvent<WorkerEncoderRequest>) => void) | null;
  postMessage: (msg: WorkerEncoderResponse, transfer?: Transferable[]) => void;
};

workerScope.onmessage = async (ev: MessageEvent<WorkerEncoderRequest>) => {
  const req = ev.data;
  try {
    if (req.type === 'quantize-gif-frame') {
      const res = quantizeSingleGifFrame(req.rgbaBuffer, req.width, req.height, req.opaqueBg);
      workerScope.postMessage(
        {
          id: req.id,
          type: 'quantize-gif-frame',
          ok: true,
          palette: res.palette,
          indexedBuffer: res.indexedBuffer,
          depth: res.depth,
          transparent: res.transparent,
        },
        [res.indexedBuffer]
      );
      return;
    }

    if (req.type === 'encode-png-bitmap') {
      const blob = await encodeBitmapToPng(req.bitmap);
      workerScope.postMessage({
        id: req.id,
        type: 'encode-png-bitmap',
        ok: true,
        blob,
      });
    }
  } catch (err) {
    workerScope.postMessage({
      id: req.id,
      type: 'error',
      ok: false,
      error: err instanceof Error ? err.message : 'Worker encoder error',
    });
  }
};
