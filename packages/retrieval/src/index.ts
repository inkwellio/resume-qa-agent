export { chunkEntries } from "./chunk.js";
export { createEmbeddingClient, embedInBatches } from "./embeddings.js";
export { parseMarkdownEntry } from "./markdown.js";
export { parsePeriod } from "./period.js";
export { createPgVectorStore } from "./pg-vector-store.js";
export { segmentDocument, segmentQuery, segmentText } from "./segment.js";
export { loadProfile, loadResumeDirectory } from "./sources.js";
export { rebuildResumeIndex, searchResume } from "./store.js";
export { VECTOR_DIMENSION } from "./vector-store.js";
export type { VectorRecord, VectorStore } from "./vector-store.js";
export type {
  ChunkType,
  ContactInfo,
  EmbeddingClient,
  Profile,
  RawEntry,
  ResumeChunk,
  SearchQuery,
} from "./types.js";
export { CHUNK_TYPES } from "./types.js";
