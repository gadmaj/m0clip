declare const codec: {
  decompress(data: Uint8Array, done: (result: number[] | null, error?: Error) => void, progress: (fraction: number) => void): void;
};
export default codec;
