export function vectorMagnitude(vector: readonly number[]): number {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

export function normalizeVector(vector: readonly number[]): readonly number[] {
  const magnitude = vectorMagnitude(vector);
  if (magnitude === 0) {
    return vector.map(() => 0);
  }

  return vector.map((value) => value / magnitude);
}

export function cosineSimilarity(first: readonly number[], second: readonly number[]): number {
  assertSameDimensions(first, second);

  const firstMagnitude = vectorMagnitude(first);
  const secondMagnitude = vectorMagnitude(second);
  if (firstMagnitude === 0 || secondMagnitude === 0) {
    return 0;
  }

  return dotProduct(first, second) / (firstMagnitude * secondMagnitude);
}

export function isFiniteVector(vector: readonly number[]): boolean {
  return vector.length > 0 && vector.every((value) => Number.isFinite(value));
}

function dotProduct(first: readonly number[], second: readonly number[]): number {
  return first.reduce((sum, value, index) => sum + value * (second[index] ?? 0), 0);
}

function assertSameDimensions(first: readonly number[], second: readonly number[]): void {
  if (first.length !== second.length) {
    throw new Error(`Vector dimensions differ: ${first.length} !== ${second.length}.`);
  }
}
