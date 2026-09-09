import { fromTransferable as geometryFromTransferable } from "./geometry";
import { fromTransferable as scatterersFomTransferable } from "./scene_sampler";
import { runSarProcessing, type SimSettings } from "./processing";
import type {
  SarGeometryTransfer,
  SarImage,
  SarScattererTransfer,
} from "./types";

export interface SarWorkerRequest {
  type: "simulate";
  requestId: number;
  params: SimSettings;
  geometry: SarGeometryTransfer;
  scatterers: SarScattererTransfer[];
}

export interface SarWorkerResponse {
  type: "result" | "error";
  requestId: number;
  image?: SarImage;
  error?: string;
}

self.onmessage = (event: MessageEvent<SarWorkerRequest>) => {
  const message = event.data;
  if (message.type !== "simulate") return;

  try {
    const geometry = geometryFromTransferable(message.geometry);
    const scatterers = scatterersFomTransferable(message.scatterers);
    const image = runSarProcessing(message.params, geometry, scatterers);

    const response: SarWorkerResponse = {
      type: "result",
      requestId: message.requestId,
      image,
    };
    (self as unknown as Worker).postMessage(response, [image.data.buffer]);
  } catch (error) {
    const response: SarWorkerResponse = {
      type: "error",
      requestId: message.requestId,
      error: error instanceof Error ? error.message : String(error),
    };
    (self as unknown as Worker).postMessage(response);
  }
};
