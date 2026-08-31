export interface ModelSelectionRef {
  current: { provider: string; model: string } | undefined
  assembled: { provider: string; model: string } | undefined
}

export function installModelSelection(_context: unknown, _selection: ModelSelectionRef): () => void {
  return () => undefined
}
