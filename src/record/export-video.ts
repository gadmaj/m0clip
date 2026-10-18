/** Frame-accurate offline rendering of a take. Each output frame is posed from the take at its exact
 * time, rendered through the shot camera at the output resolution, and handed to a WebCodecs encoder
 * (muxed by mediabunny) — so the file plays at true speed and full smoothness whatever the browser
 * managed in real time. PNG sequences are zipped as they render. mediabunny loads on first use. */
import { Zip, ZipPassThrough } from "fflate";
import type { VideoCodec } from "mediabunny";
import type * as THREE from "three";
import type { SceneView } from "../render/scene";

export type Container = "mp4" | "mov" | "webm" | "png";
export type QualityLevel = "medium" | "high" | "very-high";

export interface VideoJob {
  width: number; height: number;
  fps: number;
  speed: number;            // take seconds per output second
  t0: number; t1: number;   // take range
  container: Container;
  codec: VideoCodec;        // ignored for png
  quality: QualityLevel;
  transparent: boolean;     // png, or webm with VP8/VP9 (alpha side data)
  floor: boolean;
}

export const CONTAINER_LABEL: Record<Container, string> = {
  mp4: "MP4", mov: "MOV (QuickTime)", webm: "WebM", png: "PNG sequence (.zip)",
};
/** Codecs per container, preferred first. */
export const CODECS: Record<Exclude<Container, "png">, VideoCodec[]> = {
  mp4: ["avc", "hevc", "av1", "vp9"],
  mov: ["avc", "hevc"],
  webm: ["vp9", "av1", "vp8"],
};
export const CODEC_LABEL: Record<VideoCodec, string> = {
  avc: "H.264", hevc: "H.265 / HEVC", av1: "AV1", vp9: "VP9", vp8: "VP8", prores: "ProRes",
};

export const canAlpha = (j: Pick<VideoJob, "container" | "codec">) =>
  j.container === "png" || (j.container === "webm" && (j.codec === "vp9" || j.codec === "vp8"));

export const frameCount = (j: Pick<VideoJob, "t0" | "t1" | "speed" | "fps">) =>
  Math.max(1, Math.round(((j.t1 - j.t0) / j.speed) * j.fps));

/** Which codecs this browser can encode at the given size. */
export async function encodableCodecs(width: number, height: number, fps: number): Promise<Set<VideoCodec>> {
  const all = [...new Set(Object.values(CODECS).flat())];
  if (typeof VideoEncoder === "undefined") return new Set();
  const { canEncodeVideo, Quality } = await import("mediabunny");
  const ok = await Promise.all(all.map((c) =>
    canEncodeVideo(c, { width, height, frameRate: fps, quality: new Quality("high") }).catch(() => false)));
  return new Set(all.filter((_, i) => ok[i]));
}

export interface Stage {
  prepare?(): Promise<void>; // wait for recorded robot and map visuals before rendering frames
  view: SceneView;
  /** pose the scene at take time t */
  pose(t: number): void;
  /** aim the camera at take time t for a frame of the given aspect */
  aim(cam: THREE.PerspectiveCamera, t: number, aspect: number): void;
  camera: THREE.PerspectiveCamera;
}

export interface Progress { frame: number; frames: number; fps: number }

const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

/** Render + encode. Resolves to the finished file; rejects with an AbortError when `signal` aborts. */
export async function renderVideo(job: VideoJob, stage: Stage, onProgress: (p: Progress) => void,
                                  signal: AbortSignal): Promise<Blob> {
  await stage.prepare?.();
  if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
  const { view, camera } = stage;
  const N = frameCount(job), aspect = job.width / job.height;
  const transparent = job.transparent && canAlpha(job);
  view.beginOffscreen(job.width, job.height, { transparent, floor: job.floor });
  const canvas = view.renderer.domElement, gl = view.renderer.getContext();
  const started = performance.now();
  let lastYield = started;
  const step = async (i: number) => {
    const t = Math.min(job.t1, job.t0 + (i * job.speed) / job.fps);
    stage.pose(t);
    stage.aim(camera, t, aspect);
    view.renderWith(camera);
    if (gl.isContextLost()) throw new Error("the WebGL context was lost (GPU reset or out of memory)");
    const now = performance.now();
    if (now - lastYield > 60) {
      onProgress({ frame: i + 1, frames: N, fps: (i + 1) / ((now - started) / 1000) });
      lastYield = now;
      await yieldToUi();
    }
    if (signal.aborted) throw new DOMException("export cancelled", "AbortError");
  };
  try {
    if (job.container === "png") return await renderPngZip(N, canvas, step);
    const { BufferTarget, CanvasSource, MovOutputFormat, Mp4OutputFormat, Output, Quality, WebMOutputFormat } =
      await import("mediabunny");
    const format = job.container === "mp4" ? new Mp4OutputFormat({ fastStart: "in-memory" })
      : job.container === "mov" ? new MovOutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat();
    const output = new Output({ format, target: new BufferTarget() });
    const source = new CanvasSource(canvas, {
      codec: job.codec, quality: new Quality(job.quality), keyFrameInterval: 1,
      alpha: transparent ? "keep" : "discard",
    });
    output.addVideoTrack(source, { frameRate: job.fps });
    await output.start();
    try {
      for (let i = 0; i < N; i++) {
        await step(i);
        await source.add(i / job.fps, 1 / job.fps);
      }
      await output.finalize();
    } catch (e) {
      await output.cancel().catch(() => {});
      throw e;
    }
    return new Blob([output.target.buffer!], { type: format.mimeType });
  } finally {
    view.endOffscreen();
  }
}

/** PNG frames into a store-only zip, spilled into Blob parts as it grows so long 4K sequences do
 * not have to sit in one ArrayBuffer. */
async function renderPngZip(N: number, canvas: HTMLCanvasElement, step: (i: number) => Promise<void>): Promise<Blob> {
  const parts: Blob[] = [];
  let pending: Uint8Array[] = [], pendingBytes = 0;
  const spill = () => { if (pending.length) { parts.push(new Blob(pending as Uint8Array<ArrayBuffer>[])); pending = []; pendingBytes = 0; } };
  let done!: () => void, fail!: (e: unknown) => void;
  const finished = new Promise<void>((res, rej) => { done = res; fail = rej; });
  const zip = new Zip((err, chunk, final) => {
    if (err) return fail(err);
    pending.push(chunk);
    pendingBytes += chunk.length;
    if (pendingBytes > 64 << 20) spill();
    if (final) done();
  });
  const digits = Math.max(4, String(N).length);
  for (let i = 0; i < N; i++) {
    await step(i);
    const png = await new Promise<Blob>((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error("PNG encode failed"))), "image/png"));
    const file = new ZipPassThrough(`frame_${String(i + 1).padStart(digits, "0")}.png`);
    zip.add(file);
    file.push(new Uint8Array(await png.arrayBuffer()), true);
  }
  zip.end();
  await finished;
  spill();
  return new Blob(parts, { type: "application/zip" });
}
