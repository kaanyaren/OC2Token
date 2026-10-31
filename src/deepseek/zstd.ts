import { spawnSync } from "node:child_process";
import * as zlib from "node:zlib";

const ZSTD_MAGIC = 0xfd2fb528;
const SKIPPABLE_MAGIC_MASK = 0xfffffff0;
const SKIPPABLE_MAGIC = 0x184d2a50;
const MAX_DECOMPRESSED_BYTES = 512 * 1024 * 1024;

type ZstdDecompress = (buffer: Buffer) => Buffer;

function nodeZstdDecompress(): ZstdDecompress | undefined {
  const candidate = (zlib as unknown as { zstdDecompressSync?: ZstdDecompress }).zstdDecompressSync;
  return typeof candidate === "function" ? candidate : undefined;
}

export function isZstdDecompressionAvailable(): boolean {
  return nodeZstdDecompress() !== undefined || zstdCliAvailable();
}

let cachedCliAvailability: boolean | undefined;

function zstdCliAvailable(): boolean {
  if (cachedCliAvailability !== undefined) return cachedCliAvailability;
  try {
    const result = spawnSync("zstd", ["--version"], { stdio: "ignore" });
    cachedCliAvailability = result.status === 0;
  } catch {
    cachedCliAvailability = false;
  }
  return cachedCliAvailability;
}

/**
 * Node's Zstandard API decodes exactly one frame. DeepSeek Harness writes one
 * frame per append batch, so a log is a concatenation and must be split before
 * decoding. Frame boundaries are derived from the zstd frame/block headers;
 * skippable frames are ignored.
 */
export function splitZstdFrames(buffer: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let offset = 0;

  const need = (count: number): void => {
    if (offset + count > buffer.length) {
      throw new Error("corrupt Zstandard log: truncated frame");
    }
  };

  while (offset < buffer.length) {
    need(4);
    const magic = buffer.readUInt32LE(offset);
    if ((magic & SKIPPABLE_MAGIC_MASK) === SKIPPABLE_MAGIC) {
      need(8);
      const size = buffer.readUInt32LE(offset + 4);
      offset += 8 + size;
      if (offset > buffer.length) {
        throw new Error("corrupt Zstandard log: truncated skippable frame");
      }
      continue;
    }
    if (magic !== ZSTD_MAGIC) {
      throw new Error("corrupt Zstandard log: bad frame magic");
    }

    const start = offset;
    offset += 4;
    need(1);
    const descriptor = buffer[offset]!;
    offset += 1;
    const contentSizeFlag = descriptor >> 6;
    const singleSegment = ((descriptor >> 5) & 1) === 1;
    const checksum = ((descriptor >> 2) & 1) === 1;
    const dictionaryFlag = descriptor & 3;

    if (!singleSegment) {
      need(1);
      offset += 1; // window descriptor
    }
    const dictionarySize = [0, 1, 2, 4][dictionaryFlag]!;
    need(dictionarySize);
    offset += dictionarySize;

    const contentSizeBytes =
      contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8;
    need(contentSizeBytes);
    offset += contentSizeBytes;

    for (;;) {
      need(3);
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) === 1;
      const blockType = (blockHeader >> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0 || blockType === 2) {
        need(blockSize);
        offset += blockSize;
      } else if (blockType === 1) {
        need(1);
        offset += 1;
      } else {
        throw new Error("corrupt Zstandard log: reserved block type");
      }
      if (lastBlock) break;
    }

    if (checksum) {
      need(4);
      offset += 4;
    }
    frames.push(buffer.subarray(start, offset));
  }

  return frames;
}

export function decompressZstdBuffer(buffer: Buffer): Buffer {
  const decompress = nodeZstdDecompress();
  if (decompress === undefined) {
    throw new Error("Node Zstandard support is unavailable");
  }
  const frames = splitZstdFrames(buffer);
  const chunks: Buffer[] = [];
  let total = 0;
  for (const frame of frames) {
    const chunk = decompress(frame);
    total += chunk.length;
    if (total > MAX_DECOMPRESSED_BYTES) {
      throw new Error(`decompressed session log exceeds ${MAX_DECOMPRESSED_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

/** Decompress a concatenated-frame zstd log, falling back to the zstd CLI on older Node. */
export function readZstdFile(path: string, buffer: Buffer): Buffer {
  if (nodeZstdDecompress() !== undefined) {
    return decompressZstdBuffer(buffer);
  }
  const result = spawnSync("zstd", ["-dc", "--", path], {
    maxBuffer: MAX_DECOMPRESSED_BYTES,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const message = result.stderr?.toString("utf8").trim();
    throw new Error(message && message.length > 0 ? message : "zstd CLI decompression failed");
  }
  return result.stdout;
}
