export function assertApplicationDocumentPairCurrent(
  pairCurrent: boolean,
  requireCurrentPair: boolean,
): void {
  if (requireCurrentPair && !pairCurrent) {
    throw new Error("The generated document pair is not current and linked to the selected application.");
  }
}
